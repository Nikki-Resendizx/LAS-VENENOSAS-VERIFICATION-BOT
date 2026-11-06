import { api } from 'sdk';
import { OWNER_ID } from '../config.js';

export default async function (message) {
  if (!message?.chat || !message?.from) return;
  if (message.chat.type !== 'private') return;
  if (String(message.text || '').trim() === '/start') {
    await api.sendMessage({ chat_id: message.chat.id, text: 'Bienvenida al proceso privado de verificacion de LAS VENENOSAS.' });
  }
}
