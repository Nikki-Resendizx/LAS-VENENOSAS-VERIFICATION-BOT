import { db, api } from 'sdk';
import { eq } from 'sdk/db';
import { verificationTemplates } from '../schema.js';

export const TEMPLATE_DEFS = {
  welcome: { title: '👋 Bienvenida', fallback: 'Bienvenida al proceso privado de verificacion de LAS VENENOSAS.\n\nUsa /solicitar para comenzar tu solicitud.\n\nTus evidencias seran revisadas de forma privada por el equipo autorizado.' },
  video: { title: '🎥 Solicitud de videomensaje', fallback: '🎥 PASO 1 DE 3 — VIDEOMENSAJE\nEnvía un videomensaje grabado directamente desde Telegram (video circular). Debes decir tu usuario, edad, nacionalidad, fecha y hora reales de grabación, y que realizas la verificación para LAS VENENOSAS.\n\nNo envíes videos de otras personas ni archivos reenviados.' },
  zing: { title: '📸 Solicitud de foto Zing', fallback: '📸 PASO 2 DE 3 — FOTO ZING\nEnvía una fotografía actual sosteniendo un papel físico donde se lea exactamente: LAS VENENOSAS. La fotografía debe permitir comprobar que tú sostienes el papel.' },
  references: { title: '🧾 Solicitud de referencias', fallback: '🧾 PASO 3 DE 3 — REFERENCIAS DE VENTAS\nEnvía las referencias que permitan validar tu actividad de ventas. Puedes incluir enlaces, nombres de usuario y una breve explicación. No compartas contraseñas, datos bancarios ni información privada de terceros.' },
  approval: { title: '✅ Mensaje de aprobación', fallback: '🎉 Tu solicitud de verificación para LAS VENENOSAS fue aprobada. El equipo te indicará los siguientes pasos para tu perfil.' },
  rejection: { title: '❌ Mensaje de rechazo', fallback: 'Tu solicitud de verificación para LAS VENENOSAS fue rechazada. Si consideras que hubo un error, contacta al equipo administrativo.' },
  topic_request: { title: '📥 Aviso de nueva solicitud (tema)', fallback: '📥 NUEVA SOLICITUD DE VERIFICACIÓN\nUsuario: {usuario}\nNombre: {nombre}\nID Telegram: {id}\nEdad declarada: {edad}\nNacionalidad: {nacionalidad}\nExpediente: {expediente}' },
  topic_complete: { title: '🧾 Aviso de expediente completo (tema)', fallback: '🧾 REFERENCIAS DE VENTAS recibidas.\nModelo: {nombre} ({usuario})\nID Telegram: {id}\nEstado: {estado}\nEl expediente está completo y pendiente de revisión administrativa.' },
  topic_legacy_request: { title: '🗂️ Aviso de acceso a Galería (tema)', fallback: '🗂️ SOLICITUD DE ACCESO A GALERÍA\n\nModelo previamente verificada solicita acceso al registro.\nUsuario: {usuario}\nNombre: {nombre}\nID Telegram: {id}\nTipo: Acceso directo a Galería\nEstado: {estado}' },
};

export async function readTemplate(key) {
  const row = await db.select().from(verificationTemplates).where(eq(verificationTemplates.key, key)).get();
  if (!row) return { text: TEMPLATE_DEFS[key]?.fallback || '', buttons: [], media: null };
  try { return { text: TEMPLATE_DEFS[key]?.fallback || '', buttons: [], media: null, ...JSON.parse(row.value || '{}') }; }
  catch { return { text: TEMPLATE_DEFS[key]?.fallback || '', buttons: [], media: null }; }
}

export async function saveTemplate(key, value) {
  const current = await db.select().from(verificationTemplates).where(eq(verificationTemplates.key, key)).get();
  const payload = JSON.stringify(value);
  if (current) {
    await db.update(verificationTemplates).set({ value: payload, updatedAt: Math.floor(Date.now()/1000) })
      .where(eq(verificationTemplates.key, key)).run();
  } else {
    await db.insert(verificationTemplates).values({ key, value: payload, updatedAt: Math.floor(Date.now()/1000) }).run();
  }
}

function keyboardFromButtons(buttons, context = {}) {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  return { inline_keyboard: buttons.map(row => row.map(b => ({ text: renderTemplate(String(b.text), context), url: renderTemplate(String(b.url), context), style: ['primary', 'success', 'danger'].includes(b.style) ? b.style : 'primary' }))) };
}

// Variables dinámicas compartidas por todas las plantillas editables.
export const TEMPLATE_VARIABLE_HELP = [
  '{nombre} — nombre de la persona',
  '{mencion} — mención clicable de Telegram',
  '{usuario} — @usuario (o «Sin username»)',
  '{id} — ID de Telegram',
  '{fecha} — fecha actual (America/Mexico_City)',
  '{hora} — hora actual (America/Mexico_City)',
  '{fecha_hora} — fecha y hora actuales',
  '{nombre_modelo} — nombre completo de la modelo',
  '{perfil} — @usuario o nombre de perfil',
  '{bot} — LAS VENENOSAS',
  '{chat_id} — ID del chat o grupo',
  '{chat} — nombre del chat o grupo',
  '{enlace} — enlace de perfil de Telegram',
  '{estado} — estado actual de la solicitud',
  '{admin} — administrador responsable',
].join('\n')

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderTemplate(input, context = {}) {
  const user = context.user || {};
  const fullName = String(context.nombre_modelo || context.nombre || [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Modelo');
  const username = String(context.usuario || user.username || '');
  const userId = context.id ?? user.id ?? '';
  const stamp = new Date();
  const dateOptions = { timeZone: 'America/Mexico_City' };
  const fecha = stamp.toLocaleDateString('es-MX', dateOptions);
  const hora = stamp.toLocaleTimeString('es-MX', { ...dateOptions, hour: '2-digit', minute: '2-digit' });
  const profile = username ? '@' + username.replace(/^@/, '') : fullName;
  const link = context.enlace || (userId ? 'tg://user?id=' + userId : '');
  const values = {
    nombre: fullName,
    usuario: username ? '@' + username.replace(/^@/, '') : 'Sin username',
    id: userId,
    fecha,
    hora,
    fecha_hora: fecha + ' ' + hora,
    nombre_modelo: fullName,
    edad: context.edad ?? '',
    nacionalidad: context.nacionalidad ?? '',
    expediente: context.expediente ?? '',
    perfil: profile,
    bot: context.bot || 'LAS VENENOSAS',
    chat_id: context.chat_id ?? context.chat?.id ?? '',
    chat: context.chat?.title || context.chat_name || '',
    enlace: link,
    estado: context.estado || context.status || '',
    admin: context.admin || '',
  };
  values.mencion = userId
    ? '<a href="tg://user?id=' + encodeURIComponent(String(userId)) + '">' + escapeHtml(fullName) + '</a>'
    : escapeHtml(fullName);
  return String(input ?? '').replace(/\{([a-z_]+)\}/gi, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key.toLowerCase()) ? String(values[key.toLowerCase()]) : match
  );
}

export async function sendTemplate(chatId, key, fallback, extra = {}) {
  const cfg = await readTemplate(key);
  const context = extra.context || {};
  const text = renderTemplate(String(cfg.text || fallback || TEMPLATE_DEFS[key]?.fallback || ''), context);
  const configuredKeyboard = keyboardFromButtons(cfg.buttons, context);
  const appendRows = Array.isArray(extra.appendButtons) ? extra.appendButtons : [];
  const baseRows = extra.reply_markup?.inline_keyboard || configuredKeyboard?.inline_keyboard || [];
  const reply_markup = (extra.reply_markup || configuredKeyboard || appendRows.length)
    ? { inline_keyboard: [...baseRows, ...appendRows] }
    : undefined;
  const common = { chat_id: chatId, ...(extra.message_thread_id ? { message_thread_id: extra.message_thread_id } : {}), ...(reply_markup ? { reply_markup } : {}) };
  if (cfg.media?.fileId && cfg.media?.type) {
    const m = cfg.media;
    const caption = text.slice(0, 1000);
    if (m.type === 'photo') return api.sendPhoto({ ...common, photo: m.fileId, caption, parse_mode: 'HTML' });
    if (m.type === 'video') return api.sendVideo({ ...common, video: m.fileId, caption, parse_mode: 'HTML' });
    if (m.type === 'animation') return api.sendAnimation({ ...common, animation: m.fileId, caption, parse_mode: 'HTML' });
    if (m.type === 'document') return api.sendDocument({ ...common, document: m.fileId, caption, parse_mode: 'HTML' });
    if (m.type === 'audio') return api.sendAudio({ ...common, audio: m.fileId, caption, parse_mode: 'HTML' });
    if (m.type === 'voice') return api.sendVoice({ ...common, voice: m.fileId, caption, parse_mode: 'HTML' });
  }
  return api.sendMessage({ ...common, text, parse_mode: 'HTML' });
}

export function parseButtonRows(input) {
  const lines = String(input || '').split('\n').map(x => x.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const row = line.split('&&').map(part => {
      const idx = part.lastIndexOf(' - ');
      if (idx < 1) throw new Error('Cada botón debe tener el formato Texto - URL.');
      const text = part.slice(0, idx).trim();
      let urlAndStyle = part.slice(idx + 3).trim();
      let style = 'primary';
      const color = urlAndStyle.match(/\s+\[(azul|rojo|verde)\]$/i);
      if (color) {
        style = ({ azul: 'primary', rojo: 'danger', verde: 'success' })[color[1].toLowerCase()];
        urlAndStyle = urlAndStyle.slice(0, color.index).trim();
      }
      const url = urlAndStyle;
      if (!text || !/^https?:\/\//i.test(url)) throw new Error('Cada botón necesita un título y un enlace http o https válido.');
      return { text, url, style };
    });
    rows.push(row);
  }
  return rows;
}
