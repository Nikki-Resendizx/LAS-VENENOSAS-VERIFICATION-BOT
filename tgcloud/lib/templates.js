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

function keyboardFromButtons(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  return { inline_keyboard: buttons.map(row => row.map(b => ({ text: String(b.text), url: String(b.url), style: ['primary', 'success', 'danger'].includes(b.style) ? b.style : 'primary' }))) };
}

export async function sendTemplate(chatId, key, fallback, extra = {}) {
  const cfg = await readTemplate(key);
  const text = String(cfg.text || fallback || TEMPLATE_DEFS[key]?.fallback || '');
  const reply_markup = extra.reply_markup || keyboardFromButtons(cfg.buttons);
  const common = { chat_id: chatId, ...(reply_markup ? { reply_markup } : {}) };
  if (cfg.media?.fileId && cfg.media?.type) {
    const m = cfg.media;
    const caption = text.slice(0, 1000);
    if (m.type === 'photo') return api.sendPhoto({ ...common, photo: m.fileId, caption });
    if (m.type === 'video') return api.sendVideo({ ...common, video: m.fileId, caption });
    if (m.type === 'animation') return api.sendAnimation({ ...common, animation: m.fileId, caption });
    if (m.type === 'document') return api.sendDocument({ ...common, document: m.fileId, caption });
    if (m.type === 'audio') return api.sendAudio({ ...common, audio: m.fileId, caption });
    if (m.type === 'voice') return api.sendVoice({ ...common, voice: m.fileId, caption });
  }
  return api.sendMessage({ ...common, text });
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
