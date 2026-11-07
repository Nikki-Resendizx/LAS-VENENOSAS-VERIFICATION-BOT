import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import {
  verificationRequests,
  verificationAudit,
  verificationSessions,
} from '../schema.js';
import { OWNER_ID } from '../lib/config.js';
import { readTemplate, sendTemplate, TEMPLATE_DEFS } from '../lib/templates.js';\nimport { REGISTRATION_WEBAPP_URL } from '../lib/config.js';

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
  await api.sendMessage({
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

async function setAdminTemplateSession(key, step) {
  const current = await db.select().from(verificationSessions)
    .where(eq(verificationSessions.telegramId, OWNER_ID)).get();
  const values = { requestId: key, step, updatedAt: now() };
  if (current) await db.update(verificationSessions).set(values)
    .where(eq(verificationSessions.telegramId, OWNER_ID)).run();
  else await db.insert(verificationSessions).values({ telegramId: OWNER_ID, ...values }).run();
}

async function showTemplates(chatId) {
  const rows = Object.entries(TEMPLATE_DEFS).map(([key, item]) => [{
    text: item.title, callback_data: 'verify:template:open:' + key,
  }]);
  rows.push([{ text: '↩️ Volver al panel', callback_data: 'verify:list' }]);
  return api.sendMessage({ chat_id: chatId, text: '✏️ EDITOR DE MENSAJES\\n\\nSelecciona qué mensaje deseas personalizar. Cada plantilla permite editar texto, botones y multimedia, además de probar una vista previa.', reply_markup: { inline_keyboard: rows } });
}

async function showTemplateEditor(chatId, key) {
  const def = TEMPLATE_DEFS[key];
  if (!def) return api.sendMessage({ chat_id: chatId, text: 'Plantilla no reconocida.' });
  const cfg = await readTemplate(key);
  return api.sendMessage({
    chat_id: chatId,
    text: def.title + '\\n\\nTexto: ' + (cfg.text || def.fallback).slice(0, 700) +
      '\\nBotones: ' + (cfg.buttons?.length ? cfg.buttons.reduce((n, row) => n + row.length, 0) : 0) +
      '\\nMultimedia: ' + (cfg.media?.type || 'ninguno') +
      '\\n\\nElige qué deseas modificar o prueba cómo se verá.',
    reply_markup: { inline_keyboard: [
      [{ text: '📝 Modificar texto', callback_data: 'verify:template:edittext:' + key }],
      [{ text: '🔘 Modificar botones', callback_data: 'verify:template:editbuttons:' + key }],
      [{ text: '🖼️ Modificar multimedia', callback_data: 'verify:template:editmedia:' + key }],
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
    const ownerSession = await db.select().from(verificationSessions)
      .where(eq(verificationSessions.telegramId, OWNER_ID)).get();
    if (ownerSession) {
      await db.update(verificationSessions).set({
        requestId,
        step: 'admin_correction',
        updatedAt: now(),
      }).where(eq(verificationSessions.telegramId, OWNER_ID)).run();
    } else {
      await db.insert(verificationSessions).values({
        telegramId: OWNER_ID,
        requestId,
        step: 'admin_correction',
        updatedAt: now(),
      }).run();
    }
    await answer(query, 'Escribe en privado el motivo de la corrección.');
    await api.sendMessage({
      chat_id: OWNER_ID,
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
      rows.push([{ text: '🌐 Abrir WebApp de Registro', web_app: { url: 'https://registro-verifiedmodels.vercel.app' }, style: 'primary' }]);
      await sendTemplate(row.telegramId, 'approval', TEMPLATE_DEFS.approval.fallback, { reply_markup: { inline_keyboard: rows } });
    } else {
      await sendTemplate(row.telegramId, 'rejection', TEMPLATE_DEFS.rejection.fallback);
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

export default async function (query) {
  if (!query?.id || !query?.from) return;
  const actorId = Number(query.from.id);
  const data = String(query.data || '');
  if (!data.startsWith('verify:')) return;
  if (actorId !== OWNER_ID) {
    await answer(query, '⛔ Solo el propietario puede revisar expedientes.', true);
    return;
  }
  try {
    if (data === 'verify:templates') {
      await answer(query, 'Editor de mensajes');
      return showTemplates(actorId);
    }
    const templateOpen = data.match(/^verify:template:open:([a-z]+)$/);
    if (templateOpen) {
      await answer(query, 'Plantilla abierta');
      return showTemplateEditor(actorId, templateOpen[1]);
    }
    const templateAction = data.match(/^verify:template:(edittext|editbuttons|editmedia|preview):([a-z]+)$/);
    if (templateAction) {
      const [, action, key] = templateAction;
      if (!TEMPLATE_DEFS[key]) return answer(query, 'Plantilla no reconocida.', true);
      if (action === 'preview') {
        await answer(query, 'Enviando vista previa…');
        return sendTemplate(actorId, key, TEMPLATE_DEFS[key].fallback);
      }
      const steps = { edittext: 'template_text', editbuttons: 'template_buttons', editmedia: 'template_media' };
      await setAdminTemplateSession(key, steps[action]);
      const prompts = {
        edittext: '📝 Envía el nuevo texto completo de esta plantilla.',
        editbuttons: '🔘 Envía los botones con el formato: Título - https://enlace.com [azul|rojo|verde]\\nColores disponibles: [azul], [rojo] o [verde]. Si omites el color, será azul. Para colocar varios en una misma fila, sepáralos con &&. Cada nueva línea crea otra fila. Escribe quitar para eliminar todos los botones.',
        editmedia: '🖼️ Envía una foto, video, GIF, audio o documento para esta plantilla. Escribe quitar para eliminar el multimedia actual.',
      };
      await answer(query, 'Modo de edición activado.');
      return api.sendMessage({ chat_id: actorId, text: prompts[action] });
    }
    if (data === 'verify:list') {
      await answer(query, 'Actualizando lista…');
      await api.sendMessage({
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
