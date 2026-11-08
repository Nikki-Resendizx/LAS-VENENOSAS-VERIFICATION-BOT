import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import {
  verificationRequests,
  verificationEvidence,
  verificationAudit,
  verificationSessions,
  verificationTopics,
  legacyGalleryAccess,
  verificationAdmins,
} from '../schema.js';
import { OWNER_ID, VERIFY_GROUP_ID } from '../lib/config.js';
import { isVerificationAdmin } from '../lib/admins.js';
import { sendUiMessage, sendUiTemplate } from '../lib/ui.js';
import { sendTemplate, readTemplate, saveTemplate, parseButtonRows, TEMPLATE_DEFS, TEMPLATE_VARIABLE_HELP } from '../lib/templates.js';

const now = () => Math.floor(Date.now() / 1000);
const requestId = (telegramId) => String(telegramId) + '-' + Date.now();

async function reply(chatId, text) {
  return sendUiMessage({ chat_id: chatId, text });
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

async function getOrCreateModelTopic(telegramId, username, mappingKey) {
  const mappings = await db.select().from(verificationTopics).all();
  const current = mappings.find(row => row.requestId === mappingKey);
  if (current) return Number(current.topicId);
  const requests = await db.select().from(verificationRequests).all();
  const ids = new Set(requests.filter(row => Number(row.telegramId) === Number(telegramId)).map(row => row.id));
  const reusable = mappings.filter(row => ids.has(row.requestId) || row.requestId === 'legacy-' + telegramId)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))[0];
  let topicId = reusable ? Number(reusable.topicId) : 0;
  if (!topicId) {
    const topic = await api.createForumTopic({ chat_id: VERIFY_GROUP_ID, name: 'Modelo ' + String(username || telegramId).slice(0, 40) });
    topicId = Number(topic?.message_thread_id);
    if (!Number.isInteger(topicId) || topicId <= 0) throw new Error('Telegram no devolvió un identificador de tema válido.');
  }
  await db.insert(verificationTopics).values({ requestId: mappingKey, groupId: VERIFY_GROUP_ID, topicId, createdAt: now() }).run();
  return topicId;
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
    return sendUiTemplate(chatId, 'welcome', TEMPLATE_DEFS.welcome.fallback, {
      context: { user: message.from, chat: message.chat, chat_id: chatId, id: telegramId, nombre_modelo: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '), estado: 'BIENVENIDA' },
      appendButtons: [
        [{ text: '✅ Ya estoy verificada', callback_data: 'legacy:request' }],
        [{ text: '📝 Soy nueva, quiero verificarme', callback_data: 'legacy:new' }],
      ],
    });
  }

  if (text === '/admin' || text.startsWith('/admin ')) {
    if (!(await isVerificationAdmin(telegramId))) return reply(chatId, '⛔ No tienes autorización para abrir el panel de revisión.');
    const pending = (await db.select().from(verificationRequests).all())
      .filter(row => row.status === 'EN_REVISION')
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 15);
    const pendingButtons = pending.map(row => ({
      text: '📂 ' + (row.username ? '@' + row.username : String(row.telegramId)),
      callback_data: 'verify:open:' + row.id,
    }));
    const keyboard = [];
    for (let i = 0; i < pendingButtons.length; i += 3) keyboard.push(pendingButtons.slice(i, i + 3));
    const legacyPending = (await db.select().from(legacyGalleryAccess).all()).filter(row => row.status === 'PENDING');
    const adminButtons = [
      { text: '🗂️ Accesos a Galería (' + legacyPending.length + ')', callback_data: 'legacy:list' },
      { text: '➕ Agregar IDs aprobados', callback_data: 'legacy:add' },
      { text: '✏️ Editar mensajes', callback_data: 'verify:templates' },
      { text: '👥 Administradores de apoyo', callback_data: 'admins:list' },
      { text: '🔄 Actualizar', callback_data: 'verify:list' },
    ];
    for (let i = 0; i < adminButtons.length; i += 3) keyboard.push(adminButtons.slice(i, i + 3));
    return sendUiMessage({
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

  if (await isVerificationAdmin(telegramId) && session?.step === 'legacy_add_ids') {
    const ids = [...new Set(text.split(/[\s,;]+/).map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0))];
    if (!ids.length) return reply(chatId, 'No detecté IDs válidos. Envía uno o varios IDs numéricos separados por espacios, comas o saltos de línea.');
    let added = 0;
    for (const id of ids) {
      const current = await db.select().from(legacyGalleryAccess).where(eq(legacyGalleryAccess.telegramId, id)).get();
      const values = { username: '', firstName: '', status: 'AUTHORIZED', source: 'ADMIN_LIST', requestedAt: now(), reviewedBy: OWNER_ID, reviewedAt: now() };
      if (current) await db.update(legacyGalleryAccess).set(values).where(eq(legacyGalleryAccess.telegramId, id)).run();
      else await db.insert(legacyGalleryAccess).values({ telegramId: id, ...values }).run();
      added++;
    }
    await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
    return sendUiMessage({ chat_id: chatId, text: '✅ Se agregaron/autorizaron ' + added + ' ID(s). Esas cuentas podrán elegir «Ya estoy verificada» y pasar al registro de Galería.', reply_markup: { inline_keyboard: [[{ text: '🗂️ Ver accesos', callback_data: 'legacy:list' }], [{ text: '↩️ Panel', callback_data: 'verify:list' }]] } });
  }

  if (await isVerificationAdmin(telegramId) && session?.step?.startsWith('template_')) {
    const key = session.requestId;
    const cfg = await readTemplate(key);
    if (session.step === 'template_text') {
      if (!text || text.length > 3500) return reply(chatId, 'Envía el texto de la plantilla (máximo 3500 caracteres).');
      cfg.text = text;
      await saveTemplate(key, cfg);
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return sendUiMessage({ chat_id: chatId, text: '✅ Texto guardado para: ' + TEMPLATE_DEFS[key].title, reply_markup: { inline_keyboard: [[{ text: '👁️ Vista previa', callback_data: 'verify:template:preview:' + key }], [{ text: '↩️ Volver a plantillas', callback_data: 'verify:templates' }]] } });
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

  if (await isVerificationAdmin(telegramId) && session?.step === 'admin_correction') {
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

  if (telegramId === OWNER_ID && session?.step === 'admin_add_ids') {
    const ids = [...new Set(text.split(/[\s,;]+/).map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0 && value !== OWNER_ID))];
    if (!ids.length) return reply(chatId, 'Envía uno o varios IDs numéricos válidos, distintos del Owner.');
    let added = 0;
    for (const id of ids) {
      const exists = await db.select().from(verificationAdmins).where(eq(verificationAdmins.telegramId, id)).get();
      if (!exists) { await db.insert(verificationAdmins).values({ telegramId: id, addedBy: OWNER_ID, createdAt: now() }).run(); added++; }
    }
    await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
    return api.sendMessage({ chat_id: chatId, text: '✅ Administradores agregados: ' + added + '. Los administradores de apoyo ya pueden usar el panel con permisos operativos completos.', reply_markup: { inline_keyboard: [[{ text: '👥 Ver administradores', callback_data: 'admins:list' }], [{ text: '↩️ Panel', callback_data: 'verify:list' }]] } });
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

    let topicId;
    try {
      topicId = await getOrCreateModelTopic(telegramId, message.from.username, session.requestId);
    } catch (error) {
      console.log('No se pudo preparar el tema de verificacion:', String(error));
      return reply(chatId, 'No pude preparar tu expediente privado en este momento. Tus datos iniciales se conservaron; intenta enviar tu nacionalidad nuevamente más tarde.');
    }
    const timestamp = now();
    await db.update(verificationRequests).set({
      topicId,
      status: 'PENDIENTE_EVIDENCIAS',
      updatedAt: timestamp,
    }).where(eq(verificationRequests.id, session.requestId)).run();
    const requestData = await db.select().from(verificationRequests).where(eq(verificationRequests.id, session.requestId)).get();
    await sendTemplate(VERIFY_GROUP_ID, 'topic_request', TEMPLATE_DEFS.topic_request.fallback, {
      message_thread_id: topicId,
      context: {
        user: message.from, chat: message.chat, chat_id: VERIFY_GROUP_ID,
        id: telegramId, nombre_modelo: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        estado: 'PENDIENTE_EVIDENCIAS', edad: requestData?.ageDeclared || 'No indicada',
        nacionalidad: text, expediente: session.requestId,
      },
    });
    await db.update(verificationSessions).set({
      step: 'videomensaje', updatedAt: timestamp,
    }).where(eq(verificationSessions.telegramId, telegramId)).run();
    await reply(chatId, '✅ Datos iniciales registrados.');
    return sendUiTemplate(chatId, 'video', undefined, { context: { user: message.from, chat: message.chat, chat_id: chatId, estado: 'PENDIENTE_EVIDENCIAS' } });
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
    return sendUiTemplate(chatId, 'zing', undefined, { context: { user: message.from, chat: message.chat, chat_id: chatId, estado: 'PENDIENTE_EVIDENCIAS' } });
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
    return sendTemplate(chatId, 'references', undefined, { context: { user: message.from, chat: message.chat, chat_id: chatId, estado: 'PENDIENTE_EVIDENCIAS' } });
  }

  if (session.step === 'referencias') {
    if (text.toLowerCase() === '/finalizar' || text.toLowerCase() === 'finalizar') {
      const topic = await db.select().from(verificationTopics).where(eq(verificationTopics.requestId, session.requestId)).get();
      if (!topic) return reply(chatId, 'No encontré el tema privado de tu expediente. Contacta al equipo para continuar.');
      await sendTemplate(VERIFY_GROUP_ID, 'topic_complete', TEMPLATE_DEFS.topic_complete.fallback, {
        message_thread_id: Number(topic.topicId),
        context: { user: message.from, chat: message.chat, chat_id: VERIFY_GROUP_ID, estado: 'EN_REVISION', expediente: session.requestId },
        reply_markup: { inline_keyboard: [[
          { text: '✅ Aprobar', callback_data: 'verify:approve:' + session.requestId },
          { text: '📝 Solicitar corrección', callback_data: 'verify:correction:' + session.requestId },
        ], [
          { text: '❌ Rechazar', callback_data: 'verify:reject:' + session.requestId },
        ]] },
      });
      await db.update(verificationRequests).set({ status: 'EN_REVISION', updatedAt: now() })
        .where(eq(verificationRequests.id, session.requestId)).run();
      const evidenceRows = await db.select().from(verificationEvidence).where(eq(verificationEvidence.requestId, session.requestId)).all();
      await db.insert(verificationAudit).values({
        id: session.requestId + '-submitted-' + now(),
        requestId: session.requestId,
        actorTelegramId: telegramId,
        action: 'SOLICITUD_ENVIADA',
        details: JSON.stringify({ evidence: evidenceRows.map(row => row.evidenceType) }),
        createdAt: now(),
      }).run();
      await db.delete(verificationSessions).where(eq(verificationSessions.telegramId, telegramId)).run();
      return reply(chatId, '🎉 ¡Tu solicitud fue enviada correctamente!\n\nTus referencias quedaron incorporadas al expediente y el estado es EN REVISIÓN. El equipo autorizado revisará tus evidencias y te notificará si necesita alguna corrección o cuando exista una resolución.');
    }

    const isPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const referenceText = String(message.text || message.caption || '').trim();
    const hasText = Boolean(referenceText);
    if (!isPhoto && !hasText) {
      return reply(chatId, 'En esta etapa puedes enviar texto, enlaces o un álbum de fotos. Cuando termines de enviar todas tus referencias, escribe /finalizar.');
    }
    if (hasText && referenceText.length > 3500) {
      return reply(chatId, 'El texto o la descripción de tus referencias no debe superar los 3500 caracteres.');
    }
    const topic = await db.select().from(verificationTopics).where(eq(verificationTopics.requestId, session.requestId)).get();
    if (!topic) return reply(chatId, 'No encontré el tema privado de tu expediente. Contacta al equipo para continuar.');

    if (isPhoto) {
      const photo = message.photo[message.photo.length - 1];
      await saveEvidence(session.requestId, 'REFERENCIAS_FOTO', message, String(photo.file_id || ''), String(photo.file_unique_id || ''));
    } else {
      await saveEvidence(session.requestId, 'REFERENCIAS_TEXTO', message);
    }
    await forwardEvidence(message, Number(topic.topicId));
    return reply(chatId, '✅ Referencia recibida y añadida a tu expediente. Puedes enviar más textos, enlaces o fotos. Cuando termines, escribe /finalizar.');
  }
}
