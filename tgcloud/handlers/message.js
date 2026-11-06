import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import {
  verificationRequests,
  verificationEvidence,
  verificationAudit,
  verificationSessions,
  verificationTopics,
} from '../schema.js';
import { OWNER_ID, VERIFY_GROUP_ID } from '../lib/config.js';
import { sendTemplate, readTemplate, saveTemplate, parseButtonRows, TEMPLATE_DEFS } from '../lib/templates.js';

const now = () => Math.floor(Date.now() / 1000);
const requestId = (telegramId) => String(telegramId) + '-' + Date.now();

async function reply(chatId, text) {
  return api.sendMessage({ chat_id: chatId, text });
}

async function saveEvidence(requestIdValue, type, message, fileId = '', uniqueId = '') {
  await db.insert(verificationEvidence).values({
    id: requestIdValue + '-' + type + '-' + message.message_id,
    requestId: requestIdValue,
    evidenceType: type,
    telegramFileId: fileId,
    telegramFileUniqueId: uniqueId,
    messageId: message.message_id,
    submittedAt: now(),
    reviewStatus: 'PENDIENTE',
  }).run();
}

async function forwardEvidence(message, topicId) {
  return api.forwardMessage({
    chat_id: VERIFY_GROUP_ID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
    message_thread_id: topicId,
  });
}

export default async function (message) {
  if (!message?.chat || !message?.from || message.chat.type !== 'private') return;
  const chatId = Number(message.chat.id);
  const telegramId = Number(message.from.id);
  const text = String(message.text || '').trim();

  if (text === '/start' || text.startsWith('/start ')) {
    return sendTemplate(chatId, 'welcome');
  }

  if (text === '/admin' || text.startsWith('/admin ')) {
    if (telegramId !== OWNER_ID) return reply(chatId, '⛔ No tienes autorización para abrir el panel de revisión.');
    const pending = (await db.select().from(verificationRequests).all())
      .filter(row => row.status === 'EN_REVISION')
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 15);
    const keyboard = pending.map(row => [{
      text: '📂 ' + (row.username ? '@' + row.username : String(row.telegramId)),
      callback_data: 'verify:open:' + row.id,
    }]);
    keyboard.push([{ text: '✏️ Editar mensajes', callback_data: 'verify:templates' }]);
    keyboard.push([{ text: '🔄 Actualizar', callback_data: 'verify:list' }]);
    return api.sendMessage({
      chat_id: chatId,
      text: '🛡️ PANEL DE VERIFICACIÓN\\n\\nSolicitudes pendientes de revisión: ' + pending.length +
        (pending.length ? '\\nSelecciona un expediente para revisarlo.' : '\\nNo hay solicitudes pendientes.'),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  if (text === '/cancelar') {
    await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
    return reply(chatId, 'Solicitud en curso cancelada. Cuando quieras comenzar de nuevo, usa /solicitar.');
  }

  if (text === '/solicitar' || text.startsWith('/solicitar ')) {
    const current = await db.select().from(verificationSessions)
      .where(eq(verificationSessions.telegramId, telegramId)).get();
    if (current) {
      return reply(chatId, 'Ya tienes una solicitud en curso. Continua con el paso que te indique el bot o usa /cancelar para detenerla.');
    }
    const id = requestId(telegramId);
    const timestamp = now();
    await db.insert(verificationRequests).values({
      id,
      telegramId,
      username: String(message.from.username || ''),
      firstName: String(message.from.first_name || ''),
      lastName: String(message.from.last_name || ''),
      status: 'INICIADA',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    await db.insert(verificationSessions).values({
      telegramId, requestId: id, step: 'edad', updatedAt: timestamp,
    }).run();
    return reply(chatId,
      '📋 INICIO DE SOLICITUD\n\nEste proceso es exclusivo para personas mayores de 18 años.\n\nEscribe tu edad en números para continuar. Si eres menor de 18 años, no continúes con el registro.');
  }

  const session = await db.select().from(verificationSessions)
    .where(eq(verificationSessions.telegramId, telegramId)).get();

  if (telegramId === OWNER_ID && session?.step?.startsWith('template_')) {
    const key = session.requestId;
    const cfg = await readTemplate(key);
    if (session.step === 'template_text') {
      if (!text || text.length > 3500) return reply(chatId, 'Envía el texto de la plantilla (máximo 3500 caracteres).');
      cfg.text = text;
      await saveTemplate(key, cfg);
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return api.sendMessage({ chat_id: chatId, text: '✅ Texto guardado para: ' + TEMPLATE_DEFS[key].title, reply_markup: { inline_keyboard: [[{ text: '👁️ Vista previa', callback_data: 'verify:template:preview:' + key }], [{ text: '↩️ Volver a plantillas', callback_data: 'verify:templates' }]] } });
    }
    if (session.step === 'template_buttons') {
      try {
        cfg.buttons = text.toLowerCase() === 'quitar' ? [] : parseButtonRows(text);
        await saveTemplate(key, cfg);
        await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
        return api.sendMessage({ chat_id: chatId, text: '✅ Botones guardados. Usa 👁️ Vista previa para comprobarlos.', reply_markup: { inline_keyboard: [[{ text: '👁️ Vista previa', callback_data: 'verify:template:preview:' + key }], [{ text: '↩️ Volver a plantillas', callback_data: 'verify:template:open:' + key }]] } });
      } catch (error) { return reply(chatId, String(error.message || error)); }
    }
    if (session.step === 'template_media') {
      let media = null;
      if (message.photo?.length) media = { type: 'photo', fileId: message.photo[message.photo.length - 1].file_id };
      else if (message.video) media = { type: 'video', fileId: message.video.file_id };
      else if (message.animation) media = { type: 'animation', fileId: message.animation.file_id };
      else if (message.document) media = { type: 'document', fileId: message.document.file_id };
      else if (message.audio) media = { type: 'audio', fileId: message.audio.file_id };
      else if (message.voice) media = { type: 'voice', fileId: message.voice.file_id };
      if (!media && text.toLowerCase() !== 'quitar') return reply(chatId, 'Envía una foto, video, GIF, audio o documento; o escribe quitar para eliminar el multimedia actual.');
      cfg.media = media;
      await saveTemplate(key, cfg);
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return api.sendMessage({ chat_id: chatId, text: media ? '✅ Multimedia guardado.' : '✅ Multimedia eliminado.', reply_markup: { inline_keyboard: [[{ text: '👁️ Vista previa', callback_data: 'verify:template:preview:' + key }], [{ text: '↩️ Volver a plantillas', callback_data: 'verify:template:open:' + key }]] } });
    }
  }

  if (telegramId === OWNER_ID && session?.step === 'admin_correction') {
    if (!text || text.length < 5 || text.length > 1500) {
      return reply(chatId, 'Escribe una indicación de corrección de entre 5 y 1500 caracteres.');
    }
    const request = await db.select().from(verificationRequests)
      .where(eq(verificationRequests.id, session.requestId)).get();
    if (!request) {
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return reply(chatId, 'No encontré el expediente asociado. La sesión de corrección se cerró.');
    }
    const timestamp = now();
    await db.update(verificationRequests).set({
      status: 'REQUIERE_CORRECCION',
      updatedAt: timestamp,
    }).where(eq(verificationRequests.id, session.requestId)).run();
    await db.insert(verificationAudit).values({
      id: session.requestId + '-correction-' + timestamp,
      requestId: session.requestId,
      actorTelegramId: telegramId,
      action: 'CORRECCION_SOLICITADA',
      details: JSON.stringify({ note: text }),
      createdAt: timestamp,
    }).run();
    try {
      await api.sendMessage({
        chat_id: request.telegramId,
        text: '📝 Tu expediente de LAS VENENOSAS requiere una corrección.\\n\\nIndicación del equipo: ' + text +
          '\\n\\nPor favor, conserva este mensaje y espera las instrucciones del equipo para reenviar el elemento solicitado.',
      });
    } catch (error) {
      console.log('No se pudo notificar la corrección al solicitante:', String(error));
    }
    await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
    return reply(chatId, '✅ Solicitud de corrección enviada a la persona solicitante y registrada en auditoría.');
  }

  if (!session) return;

  if (session.step === 'edad') {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 1 || age > 120) {
      return reply(chatId, 'Escribe solamente tu edad en números. Para continuar debes tener al menos 18 años.');
    }
    if (age < 18) {
      await db.update(verificationRequests).set({
        status: 'RECHAZADA',
        updatedAt: now(),
      }).where(eq(verificationRequests.id, session.requestId)).run();
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return reply(chatId, 'No podemos aceptar solicitudes de personas menores de 18 años. El proceso ha terminado y no debes enviar fotografías ni videos.');
    }
    await db.update(verificationRequests).set({
      ageDeclared: age,
      updatedAt: now(),
    }).where(eq(verificationRequests.id, session.requestId)).run();
    await db.update(verificationSessions).set({
      step: 'nacionalidad', updatedAt: now(),
    }).where(eq(verificationSessions.telegramId, telegramId)).run();
    return reply(chatId, 'Gracias. Ahora escribe tu nacionalidad.');
  }

  if (session.step === 'nacionalidad') {
    if (text.length < 2 || text.length > 80) return reply(chatId, 'Escribe una nacionalidad válida para continuar.');
    await db.update(verificationRequests).set({
      nationality: text,
      updatedAt: now(),
    }).where(eq(verificationRequests.id, session.requestId)).run();

    let topic;
    try {
      topic = await api.createForumTopic({
        chat_id: VERIFY_GROUP_ID,
        name: 'Solicitud ' + String(message.from.username || telegramId).slice(0, 45),
      });
    } catch (error) {
      console.log('No se pudo crear el tema de verificacion:', String(error));
      return reply(chatId, 'No pude preparar tu expediente privado en este momento. Tus datos iniciales se conservaron; intenta enviar tu nacionalidad nuevamente más tarde.');
    }
    const topicId = Number(topic?.message_thread_id);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return reply(chatId, 'No pude confirmar la creación de tu expediente privado. Por favor, contacta al equipo antes de volver a enviar tus datos.');
    }
    const timestamp = now();
    await db.insert(verificationTopics).values({
      requestId: session.requestId,
      groupId: VERIFY_GROUP_ID,
      topicId,
      createdAt: timestamp,
    }).run();
    await db.update(verificationRequests).set({
      topicId,
      status: 'PENDIENTE_EVIDENCIAS',
      updatedAt: timestamp,
    }).where(eq(verificationRequests.id, session.requestId)).run();
    await api.sendMessage({
      chat_id: VERIFY_GROUP_ID,
      message_thread_id: topicId,
      text: '📥 NUEVA SOLICITUD DE VERIFICACIÓN\n' +
        'Usuario: ' + (message.from.username ? '@' + message.from.username : 'Sin username') + '\n' +
        'ID Telegram: ' + telegramId + '\n' +
        'Edad declarada: ' + String((await db.select().from(verificationRequests).where(eq(verificationRequests.id, session.requestId)).get())?.ageDeclared || 'No indicada') + '\n' +
        'Nacionalidad: ' + text + '\n' +
        'Expediente: ' + session.requestId,
    });
    await db.update(verificationSessions).set({
      step: 'videomensaje', updatedAt: timestamp,
    }).where(eq(verificationSessions.telegramId, telegramId)).run();
    await reply(chatId, '✅ Datos iniciales registrados.');
    return sendTemplate(chatId, 'video');
  }

  if (session.step === 'videomensaje') {
    if (!message.video_note) {
      return reply(chatId, 'Necesito que envíes un videomensaje circular grabado directamente desde Telegram. Usa el botón de cámara de video junto al campo de escritura.');
    }
    const v = message.video_note;
    await saveEvidence(session.requestId, 'VIDEOMENSAJE', message, String(v.file_id || ''), String(v.file_unique_id || ''));
    const topic = await db.select().from(verificationTopics).where(eq(verificationTopics.requestId, session.requestId)).get();
    await forwardEvidence(message, Number(topic.topicId));
    await db.update(verificationSessions).set({ step: 'foto_zing', updatedAt: now() })
      .where(eq(verificationSessions.telegramId, telegramId)).run();
    await reply(chatId, '🎥 Videomensaje recibido y enviado a tu expediente privado.');
    return sendTemplate(chatId, 'zing');
  }

  if (session.step === 'foto_zing') {
    if (!Array.isArray(message.photo) || !message.photo.length) {
      return reply(chatId, 'Envía una fotografía como imagen, no como documento, sosteniendo el papel físico con el texto exacto LAS VENENOSAS.');
    }
    const photo = message.photo[message.photo.length - 1];
    await saveEvidence(session.requestId, 'FOTO_ZING', message, String(photo.file_id || ''), String(photo.file_unique_id || ''));
    const topic = await db.select().from(verificationTopics).where(eq(verificationTopics.requestId, session.requestId)).get();
    await forwardEvidence(message, Number(topic.topicId));
    await db.update(verificationSessions).set({ step: 'referencias', updatedAt: now() })
      .where(eq(verificationSessions.telegramId, telegramId)).run();
    await reply(chatId, '📸 Foto recibida y guardada en tu expediente privado.');
    return sendTemplate(chatId, 'references');
  }

  if (session.step === 'referencias') {
    if (text.length < 5 || text.length > 3500) {
      return reply(chatId, 'Envía tus referencias en un mensaje de texto de entre 5 y 3500 caracteres. Si no tienes referencias, explica brevemente tu situación.');
    }
    const topic = await db.select().from(verificationTopics).where(eq(verificationTopics.requestId, session.requestId)).get();
    await forwardEvidence(message, Number(topic.topicId));
    await api.sendMessage({
      chat_id: VERIFY_GROUP_ID,
      message_thread_id: Number(topic.topicId),
      text: '🧾 REFERENCIAS DE VENTAS recibidas. El expediente está completo y pendiente de revisión administrativa.',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Aprobar', callback_data: 'verify:approve:' + session.requestId },
        { text: '📝 Solicitar corrección', callback_data: 'verify:correction:' + session.requestId },
      ], [
        { text: '❌ Rechazar', callback_data: 'verify:reject:' + session.requestId },
      ]] },
    });
    await db.update(verificationRequests).set({
      status: 'EN_REVISION',
      updatedAt: now(),
    }).where(eq(verificationRequests.id, session.requestId)).run();
    await db.insert(verificationAudit).values({
      id: session.requestId + '-submitted-' + now(),
      requestId: session.requestId,
      actorTelegramId: telegramId,
      action: 'SOLICITUD_ENVIADA',
      details: JSON.stringify({ evidence: ['VIDEOMENSAJE', 'FOTO_ZING', 'REFERENCIAS'] }),
      createdAt: now(),
    }).run();
    await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
    return reply(chatId,
      '🎉 ¡Tu solicitud fue enviada correctamente!\n\nTu expediente quedó en estado: EN REVISIÓN. El equipo autorizado revisará tus evidencias y te notificará si necesita alguna corrección o cuando exista una resolución.\n\nPor seguridad, no envíes nuevamente tus evidencias salvo que el equipo te lo solicite.');
  }
}
