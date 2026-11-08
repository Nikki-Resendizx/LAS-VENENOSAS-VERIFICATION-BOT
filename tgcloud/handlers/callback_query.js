import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import {
  verificationRequests,
  verificationAudit,
  verificationSessions,
  legacyGalleryAccess,
  verificationTopics,
  verificationAdmins,
} from '../schema.js';import { OWNER_ID, REGISTRATION_WEBAPP_URL, VERIFY_GROUP_ID } from '../lib/config.js';
import { readTemplate, saveTemplate, sendTemplate, TEMPLATE_DEFS, TEMPLATE_VARIABLE_HELP } from '../lib/templates.js';
import { isVerificationAdmin } from '../lib/admins.js';
import { sendUiMessage, sendUiTemplate } from '../lib/ui.js';

const now = () => Math.floor(Date.now() / 1000);

async function answer(query, text, alert = false) {
  return api.answerCallbackQuery({
    callback_query_id: query.id,
    text,
    ...(alert ? { show_alert: true } : {}),
  });
}

async function showRequest(query, requestId) {
  const row = await db.select().from(verificationRequests)
    .where(eq(verificationRequests.id, requestId)).get();
  if (!row) {
    await answer(query, 'No encontré ese expediente.', true);
    return;
  }
  const text = '📂 EXPEDIENTE DE VERIFICACIÓN\\n\\n' +
    'Usuario: ' + (row.username ? '@' + row.username : 'Sin username') + '\\n' +
    'ID Telegram: ' + row.telegramId + '\\n' +
    'Nombre: ' + [row.firstName, row.lastName].filter(Boolean).join(' ') + '\\n' +
    'Edad declarada: ' + (row.ageDeclared || 'No indicada') + '\\n' +
    'Nacionalidad: ' + (row.nationality || 'No indicada') + '\\n' +
    'Estado: ' + row.status + '\\n' +
    'Expediente: ' + row.id;
  await sendUiMessage({
    chat_id: query.from.id,
    text,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Aprobar', callback_data: 'verify:approve:' + row.id },
      { text: '📝 Solicitar corrección', callback_data: 'verify:correction:' + row.id },
    ], [
      { text: '❌ Rechazar', callback_data: 'verify:reject:' + row.id },
    ]] },
  });
  await answer(query, 'Expediente abierto.');
}

async function setAdminTemplateSession(adminId, key, step) {
  const current = await db.select().from(verificationSessions)
    .where(eq(verificationSessions.telegramId, adminId)).get();
  const values = { requestId: key, step, updatedAt: now() };
  if (current) await db.update(verificationSessions).set(values)
    .where(eq(verificationSessions.telegramId, adminId)).run();
  else await db.insert(verificationSessions).values({ telegramId: adminId, ...values }).run();
}

async function showTemplates(chatId) {
  const rows = Object.entries(TEMPLATE_DEFS).map(([key, item]) => [{
    text: item.title, callback_data: 'verify:template:open:' + key,
  }]);
  rows.push([{ text: '↩️ Volver al panel', callback_data: 'verify:list' }]);
  return sendUiMessage({ chat_id: chatId, text: '✏️ EDITOR DE MENSAJES\\n\\nSelecciona qué mensaje deseas personalizar. Cada plantilla permite editar texto, botones y multimedia, además de probar una vista previa.', reply_markup: { inline_keyboard: rows } });
}

async function showTemplateEditor(chatId, key) {
  const def = TEMPLATE_DEFS[key];
  if (!def) return sendUiMessage({ chat_id: chatId, text: 'Plantilla no reconocida.' });
  const cfg = await readTemplate(key);
  return sendUiMessage({
    chat_id: chatId,
    text: def.title + '\\n\\nTexto: ' + (cfg.text || def.fallback).slice(0, 700) +
      '\\nBotones: ' + (cfg.buttons?.length ? cfg.buttons.reduce((n, row) => n + row.length, 0) : 0) +
      '\\nMultimedia: ' + (cfg.media?.type || 'ninguno') +
      '\\n\\nElige qué deseas modificar o prueba cómo se verá.',
    reply_markup: { inline_keyboard: [
      [{ text: '📝 Modificar texto', callback_data: 'verify:template:edittext:' + key }],
      [{ text: '🔘 Modificar botones', callback_data: 'verify:template:editbuttons:' + key }],
      [{ text: '🖼️ Modificar multimedia', callback_data: 'verify:template:editmedia:' + key }],
      [
        { text: '↩️ Texto predeterminado', callback_data: 'verify:template:resettext:' + key },
        { text: '↩️ Botones predeterminados', callback_data: 'verify:template:resetbuttons:' + key },
      ],
      [{ text: '↩️ Multimedia predeterminado', callback_data: 'verify:template:resetmedia:' + key }],
      [{ text: '👁️ Vista previa', callback_data: 'verify:template:preview:' + key }],
      [{ text: '↩️ Volver', callback_data: 'verify:templates' }],
    ] },
  });
}

async function handleDecision(query, action, requestId) {
  const row = await db.select().from(verificationRequests)
    .where(eq(verificationRequests.id, requestId)).get();
  if (!row) {
    await answer(query, 'No encontré ese expediente.', true);
    return;
  }
  if (!['EN_REVISION', 'REQUIERE_CORRECCION'].includes(String(row.status))) {
    await answer(query, 'Este expediente ya no está pendiente de revisión.', true);
    return;
  }

  if (action === 'correction') {
    const adminId = Number(query.from.id);
    const ownerSession = await db.select().from(verificationSessions)
      .where(eq(verificationSessions.telegramId, adminId)).get();
    if (ownerSession) {
      await db.update(verificationSessions).set({
        requestId,
        step: 'admin_correction',
        updatedAt: now(),
      }).where(eq(verificationSessions.telegramId, adminId)).run();
    } else {
      await db.insert(verificationSessions).values({
        telegramId: adminId,
        requestId,
        step: 'admin_correction',
        updatedAt: now(),
      }).run();
    }
    await answer(query, 'Escribe en privado el motivo de la corrección.');
    await sendUiMessage({
      chat_id: adminId,
      text: '📝 Escribe ahora el motivo o los elementos que debe corregir la persona solicitante.\\n\\nExpediente: ' + requestId,
    });
    return;
  }

  const status = action === 'approve' ? 'APROBADA' : 'RECHAZADA';
  const timestamp = now();
  await db.update(verificationRequests).set({
    status,
    reviewedBy: Number(query.from.id),
    reviewedAt: timestamp,
    updatedAt: timestamp,
  }).where(eq(verificationRequests.id, requestId)).run();
  await db.insert(verificationAudit).values({
    id: requestId + '-' + action + '-' + timestamp,
    requestId,
    actorTelegramId: Number(query.from.id),
    action: action === 'approve' ? 'SOLICITUD_APROBADA' : 'SOLICITUD_RECHAZADA',
    details: JSON.stringify({ previousStatus: row.status, status }),
    createdAt: timestamp,
  }).run();

  try {
    if (action === 'approve') {
      const cfg = await readTemplate('approval');
      const rows = Array.isArray(cfg.buttons) ? cfg.buttons.map(r => r.map(b => ({ text: String(b.text), url: String(b.url), style: ['primary', 'success', 'danger'].includes(b.style) ? b.style : 'primary' }))) : [];
      rows.push([{ text: '🌐 Abrir WebApp de Registro', web_app: { url: REGISTRATION_WEBAPP_URL }, style: 'primary' }]);
      await sendUiTemplate(row.telegramId, 'approval', TEMPLATE_DEFS.approval.fallback, { context: { user: { id: row.telegramId, username: row.username, first_name: row.firstName }, id: row.telegramId, nombre_modelo: [row.firstName, row.lastName].filter(Boolean).join(' '), estado: status, admin: query.from.username ? '@' + query.from.username : String(query.from.id) }, reply_markup: { inline_keyboard: rows } });
    } else {
      await sendUiTemplate(row.telegramId, 'rejection', TEMPLATE_DEFS.rejection.fallback, { context: { user: { id: row.telegramId, username: row.username, first_name: row.firstName }, id: row.telegramId, nombre_modelo: [row.firstName, row.lastName].filter(Boolean).join(' '), estado: status, admin: query.from.username ? '@' + query.from.username : String(query.from.id) } });
    }
  } catch (error) {
    console.log('No se pudo notificar la resolución al solicitante:', String(error));
  }
  await answer(query, action === 'approve' ? 'Solicitud aprobada.' : 'Solicitud rechazada.');
  if (query.message?.chat?.id && query.message?.message_id) {
    await api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: '📁 EXPEDIENTE ' + status + '\\n\\nUsuario: ' +
        (row.username ? '@' + row.username : String(row.telegramId)) +
        '\\nID Telegram: ' + row.telegramId,
    });
  }
}


async function getOrCreateLegacyTopic(telegramId, username) {
  const mappingKey = 'legacy-' + telegramId;
  const mappings = await db.select().from(verificationTopics).all();
  const current = mappings.find(row => row.requestId === mappingKey);
  if (current) return Number(current.topicId);
  const requests = await db.select().from(verificationRequests).all();
  const ids = new Set(requests.filter(row => Number(row.telegramId) === Number(telegramId)).map(row => row.id));
  const reusable = mappings.filter(row => ids.has(row.requestId)).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))[0];
  let topicId = reusable ? Number(reusable.topicId) : 0;
  if (!topicId) {
    const topic = await api.createForumTopic({ chat_id: VERIFY_GROUP_ID, name: 'Modelo ' + String(username || telegramId).slice(0, 40) });
    topicId = Number(topic?.message_thread_id);
    if (!Number.isInteger(topicId) || topicId <= 0) throw new Error('No se pudo crear un tema válido.');
  }
  await db.insert(verificationTopics).values({ requestId: mappingKey, groupId: VERIFY_GROUP_ID, topicId, createdAt: now() }).run();
  return topicId;
}

async function legacyRequest(query) {
  const id = Number(query.from.id);
  const current = await db.select().from(legacyGalleryAccess)
    .where(eq(legacyGalleryAccess.telegramId, id)).get();
  if (current?.status === 'AUTHORIZED') {
    await sendUiMessage({ chat_id: id, text: '✅ Tu acceso para registrarte en la Galería ya está autorizado. Puedes continuar sin repetir la verificación.', reply_markup: { inline_keyboard: [[{ text: '🌐 Abrir WebApp de Registro', web_app: { url: REGISTRATION_WEBAPP_URL }, style: 'primary' }]] } });
    return answer(query, 'Acceso autorizado.');
  }
  if (current?.status === 'PENDING') return answer(query, 'Tu solicitud ya está pendiente de autorización.', true);
  const timestamp = now();
  const values = { username: String(query.from.username || ''), firstName: String(query.from.first_name || ''), status: 'PENDING', source: 'REQUEST', requestedAt: timestamp, reviewedBy: null, reviewedAt: null };
  if (current) await db.update(legacyGalleryAccess).set(values).where(eq(legacyGalleryAccess.telegramId, id)).run();
  else await db.insert(legacyGalleryAccess).values({ telegramId: id, ...values }).run();
  const topicId = await getOrCreateLegacyTopic(id, query.from.username);
  await sendTemplate(VERIFY_GROUP_ID, 'topic_legacy_request', TEMPLATE_DEFS.topic_legacy_request.fallback, {
    message_thread_id: topicId,
    context: {
      user: query.from, chat_id: VERIFY_GROUP_ID, id,
      nombre_modelo: String(query.from.first_name || ''),
      estado: 'PENDIENTE DE AUTORIZACIÓN',
    },
    reply_markup: { inline_keyboard: [[
      { text: '✅ Autorizar', callback_data: 'legacy:approve:' + id },
      { text: '❌ Rechazar', callback_data: 'legacy:reject:' + id },
    ]] },
  });
  await sendUiMessage({ chat_id: OWNER_ID, text: '🗂️ Nueva solicitud de acceso registrada en el tema de la modelo: ' + id });
  return answer(query, 'Solicitud enviada al grupo de revisión. Espera la autorización del equipo.');
}

async function legacyList(query) {
  const rows = (await db.select().from(legacyGalleryAccess).all()).filter(row => row.status === 'PENDING');
  const keyboard = rows.slice(0, 30).map(row => [{ text: (row.username ? '@' + row.username : String(row.telegramId)), callback_data: 'legacy:open:' + row.telegramId }]);
  keyboard.push([{ text: '➕ Agregar IDs aprobados', callback_data: 'legacy:add' }]);
  keyboard.push([{ text: '↩️ Volver al panel', callback_data: 'verify:list' }]);
  await sendUiMessage({ chat_id: Number(query.from.id), text: '🗂️ ACCESOS A GALERÍA PENDIENTES\\n\\nSolicitudes: ' + rows.length, reply_markup: { inline_keyboard: keyboard } });
  return answer(query, 'Lista actualizada.');
}

async function legacyOpen(query, id) {
  const row = await db.select().from(legacyGalleryAccess).where(eq(legacyGalleryAccess.telegramId, Number(id))).get();
  if (!row) return answer(query, 'No encontré esa solicitud.', true);
  await sendUiMessage({ chat_id: Number(query.from.id), text: '🗂️ SOLICITUD DE ACCESO\\n\\nUsuario: ' + (row.username ? '@' + row.username : 'Sin username') + '\\nNombre: ' + (row.firstName || 'No indicado') + '\\nID Telegram: ' + row.telegramId + '\\nEstado: ' + row.status + '\\nOrigen: ' + row.source, reply_markup: { inline_keyboard: row.status === 'PENDING' ? [[{ text: '✅ Autorizar', callback_data: 'legacy:approve:' + row.telegramId }, { text: '❌ Rechazar', callback_data: 'legacy:reject:' + row.telegramId }]] : [] } });
  return answer(query, 'Solicitud abierta.');
}

async function legacyDecision(query, action, id) {
  const telegramId = Number(id);
  const row = await db.select().from(legacyGalleryAccess).where(eq(legacyGalleryAccess.telegramId, telegramId)).get();
  if (!row || row.status !== 'PENDING') return answer(query, 'La solicitud ya fue resuelta o no existe.', true);
  const status = action === 'approve' ? 'AUTHORIZED' : 'REJECTED';
  const timestamp = now();
  await db.update(legacyGalleryAccess).set({ status, reviewedBy: Number(query.from.id), reviewedAt: timestamp }).where(eq(legacyGalleryAccess.telegramId, telegramId)).run();
  if (action === 'approve') {
    await sendUiMessage({ chat_id: telegramId, text: '🎉 Tu acceso como modelo previamente verificada fue autorizado. Ya puedes continuar directamente con el registro de Galería.', reply_markup: { inline_keyboard: [[{ text: '🌐 Abrir WebApp de Registro', web_app: { url: REGISTRATION_WEBAPP_URL } }]] } });
  } else {
    await sendUiMessage({ chat_id: telegramId, text: 'Tu solicitud de acceso directo no fue autorizada. Si deseas participar, puedes iniciar el proceso normal de verificación con /solicitar.' });
  }
  await answer(query, action === 'approve' ? 'Acceso autorizado.' : 'Solicitud rechazada.');
  if (query.message?.chat?.id && query.message?.message_id) {
    try { await api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id, text: '🗂️ ACCESO ' + status + '\\nID Telegram: ' + telegramId }); } catch {}
  }
}

export default async function (query) {
  if (!query?.id || !query?.from) return;
  const actorId = Number(query.from.id);
  const data = String(query.data || '');
  if (data === 'legacy:request') return legacyRequest(query);
  if (data === 'admins:list') {
    if (!(await isVerificationAdmin(actorId))) return answer(query, '⛔ Acceso restringido.', true);
    const admins = await db.select().from(verificationAdmins).all();
    const adminButtons = admins.map(row => ({ text: '🗑️ Quitar ID ' + row.telegramId, callback_data: 'admins:remove:' + row.telegramId }));
    const keyboard = [];
    if (actorId === OWNER_ID) keyboard.push([{ text: '➕ Agregar administrador', callback_data: 'admins:add' }]);
    for (let i = 0; i < adminButtons.length; i += 3) keyboard.push(adminButtons.slice(i, i + 3));
    keyboard.push([{ text: '↩️ Volver al panel', callback_data: 'verify:list' }]);
    await answer(query, 'Administradores: ' + admins.length);
    return sendUiMessage({ chat_id: actorId, text: '👥 ADMINISTRADORES DE APOYO\\n\\n' + (admins.length ? admins.map(row => '• ' + row.telegramId).join('\\n') : 'No hay administradores de apoyo registrados.') + (actorId === OWNER_ID ? '\\n\\nSolo el Owner puede agregar nuevos administradores.' : ''), reply_markup: { inline_keyboard: keyboard } });
  }
  if (data === 'admins:add') {
    if (actorId !== OWNER_ID) return answer(query, '⛔ Solo el Owner puede agregar administradores.', true);
    await setAdminTemplateSession(actorId, '', 'admin_add_ids');
    await answer(query, 'Envía los IDs que deseas agregar.');
    return sendUiMessage({ chat_id: actorId, text: '➕ Envía uno o varios IDs de Telegram separados por espacios, comas o saltos de línea. Solo el Owner puede agregar administradores.' });
  }
  const removeAdmin = data.match(/^admins:remove:(\d+)$/);
  if (removeAdmin) {
    if (!(await isVerificationAdmin(actorId))) return answer(query, '⛔ Acceso restringido.', true);
    const targetId = Number(removeAdmin[1]);
    if (targetId === OWNER_ID) return answer(query, 'El Owner no puede ser eliminado.', true);
    await db.delete(verificationAdmins).where(eq(verificationAdmins.telegramId, targetId)).run();
    await answer(query, 'Administrador eliminado.');
    const admins = await db.select().from(verificationAdmins).all();
    const adminButtons = admins.map(row => ({ text: '🗑️ Quitar ID ' + row.telegramId, callback_data: 'admins:remove:' + row.telegramId }));
    const keyboard = [];
    if (actorId === OWNER_ID) keyboard.push([{ text: '➕ Agregar administrador', callback_data: 'admins:add' }]);
    for (let i = 0; i < adminButtons.length; i += 3) keyboard.push(adminButtons.slice(i, i + 3));
    keyboard.push([{ text: '↩️ Volver al panel', callback_data: 'verify:list' }]);
    return sendUiMessage({ chat_id: actorId, text: '👥 ADMINISTRADORES DE APOYO\\n\\n' + (admins.length ? admins.map(row => '• ' + row.telegramId).join('\\n') : 'No hay administradores registrados.'), reply_markup: { inline_keyboard: keyboard } });
  }
  if (data === 'legacy:new') {
    await answer(query, 'Puedes comenzar tu verificación nueva con /solicitar.');
    return sendUiMessage({ chat_id: actorId, text: '📝 Para iniciar tu verificación desde cero, envía /solicitar.' });
  }
  if (data.startsWith('legacy:')) {
    if (!(await isVerificationAdmin(actorId))) return answer(query, '⛔ No tienes autorización para administrar estos accesos.', true);
    if (data === 'legacy:list') return legacyList(query);
    if (data === 'legacy:add') {
      await setAdminTemplateSession(actorId, '', 'legacy_add_ids');
      await answer(query, 'Modo de carga de IDs activado.');
      return sendUiMessage({ chat_id: actorId, text: 'Envía uno o varios IDs numéricos separados por espacios, comas o saltos de línea.' });
    }
    const opened = data.match(/^legacy:open:(\\d+)$/);
    if (opened) return legacyOpen(query, opened[1]);
    const decision = data.match(/^legacy:(approve|reject):(\\d+)$/);
    if (decision) return legacyDecision(query, decision[1], decision[2]);
    return answer(query, 'Acción de acceso no reconocida.', true);
  }
  if (!data.startsWith('verify:')) return;
  if (!(await isVerificationAdmin(actorId))) {
    await answer(query, '⛔ No tienes autorización para revisar expedientes.', true);
    return;
  }
  try {
    if (data === 'verify:templates') {
      await answer(query, 'Editor de mensajes');
      return showTemplates(actorId);
    }
    const templateOpen = data.match(/^verify:template:open:([a-z_]+)$/);
    if (templateOpen) {
      await answer(query, 'Plantilla abierta');
      return showTemplateEditor(actorId, templateOpen[1]);
    }
    const templateReset = data.match(/^verify:template:reset(text|buttons|media):([a-z_]+)$/);
    if (templateReset) {
      const [, part, key] = templateReset;
      const def = TEMPLATE_DEFS[key];
      if (!def) return answer(query, 'Plantilla no reconocida.', true);
      const cfg = await readTemplate(key);
      if (part === 'text') cfg.text = def.fallback;
      if (part === 'buttons') cfg.buttons = [];
      if (part === 'media') cfg.media = null;
      await saveTemplate(key, cfg);
      await answer(query, part === 'text' ? 'Texto restaurado.' : part === 'buttons' ? 'Botones restaurados.' : 'Multimedia restaurado.');
      return showTemplateEditor(actorId, key);
    }
    const templateAction = data.match(/^verify:template:(edittext|editbuttons|editmedia|preview):([a-z_]+)$/);
    if (templateAction) {
      const [, action, key] = templateAction;
      if (!TEMPLATE_DEFS[key]) return answer(query, 'Plantilla no reconocida.', true);
      if (action === 'preview') {
        await answer(query, 'Enviando vista previa…');
        return sendUiTemplate(actorId, key, TEMPLATE_DEFS[key].fallback, { context: { user: query.from, id: query.from.id, nombre_modelo: [query.from.first_name, query.from.last_name].filter(Boolean).join(' '), estado: 'VISTA PREVIA', admin: query.from.username ? '@' + query.from.username : String(query.from.id) } });
      }
      const steps = { edittext: 'template_text', editbuttons: 'template_buttons', editmedia: 'template_media' };
      await setAdminTemplateSession(actorId, key, steps[action]);
      const prompts = {
        edittext: '📝 Envía el nuevo texto completo de esta plantilla.\\n\\nVariables disponibles:\\n' + TEMPLATE_VARIABLE_HELP,
        editbuttons: '🔘 Envía los botones con el formato: Título - https://enlace.com [azul|rojo|verde]\\nColores disponibles: [azul], [rojo] o [verde]. Si omites el color, será azul. Para colocar varios en una misma fila, sepáralos con &&. Cada nueva línea crea otra fila. Escribe quitar para eliminar todos los botones.',
        editmedia: '🖼️ Envía una foto, video, GIF, audio o documento para esta plantilla. Escribe quitar para eliminar el multimedia actual.',
      };
      await answer(query, 'Modo de edición activado.');
      return sendUiMessage({ chat_id: actorId, text: prompts[action] });
    }
    if (data === 'verify:list') {
      await answer(query, 'Actualizando lista…');
      await sendUiMessage({
        chat_id: actorId,
        text: 'Para actualizar las solicitudes pendientes, vuelve a enviar /admin.',
      });
      return;
    }
    const open = data.match(/^verify:open:(.+)$/);
    if (open) return showRequest(query, open[1]);
    const decision = data.match(/^verify:(approve|reject|correction):(.+)$/);
    if (decision) return handleDecision(query, decision[1], decision[2]);
    await answer(query, 'Acción no reconocida.', true);
  } catch (error) {
    console.log('Error en revisión de expediente:', String(error));
    try { await answer(query, 'No se pudo completar la acción.', true); } catch {}
  }
}
