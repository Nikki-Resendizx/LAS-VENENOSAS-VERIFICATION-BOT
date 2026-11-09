import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { verificationUiMessages } from '../schema.js';
import { sendTemplate, detectTelegramParseMode } from './templates.js';

const now = () => Math.floor(Date.now() / 1000);

async function removePrevious(chatId) {
  const previous = await db.select().from(verificationUiMessages)
    .where(eq(verificationUiMessages.chatId, Number(chatId))).get();
  if (previous?.messageId) {
    try {
      await api.deleteMessage({ chat_id: Number(chatId), message_id: Number(previous.messageId) });
    } catch (error) {
      // El mensaje puede haber sido borrado manualmente o ya no ser eliminable.
      console.log('No se pudo borrar el mensaje anterior de interfaz:', String(error));
    }
  }
}

async function remember(chatId, result) {
  const messageId = Number(result?.message_id);
  if (!Number.isInteger(messageId) || messageId <= 0) return result;
  const id = Number(chatId);
  const current = await db.select().from(verificationUiMessages)
    .where(eq(verificationUiMessages.chatId, id)).get();
  const values = { messageId, updatedAt: now() };
  if (current) await db.update(verificationUiMessages).set(values)
    .where(eq(verificationUiMessages.chatId, id)).run();
  else await db.insert(verificationUiMessages).values({ chatId: id, ...values }).run();
  return result;
}

function normalizeUiText(value) {
  return String(value ?? '')
    .replace(/\\\\r\\\\n|\\\\n|\\\\r/g, '\n')
    .replace(/\\r\\n|\\n|\\r/g, '\n');
}

export async function sendUiMessage(params) {
  const chatId = Number(params.chat_id);
  await removePrevious(chatId);
  const payload = { ...params };
  if (typeof payload.text === 'string') {
    payload.text = normalizeUiText(payload.text);
    // Detectar automáticamente el formato Telegram para todas las respuestas
    // de interfaz (HTML, Markdown y MarkdownV2), salvo que el llamador
    // haya definido parse_mode o entidades explícitamente.
    if (!payload.parse_mode && !payload.entities?.length) {
      const detectedMode = detectTelegramParseMode(payload.text);
      if (detectedMode) payload.parse_mode = detectedMode;
    }
  }
  const result = await api.sendMessage(payload);
  return remember(chatId, result);
}

export async function sendUiTemplate(chatId, key, fallback, extra = {}) {
  await removePrevious(chatId);
  const result = await sendTemplate(chatId, key, fallback, extra);
  return remember(chatId, result);
}
