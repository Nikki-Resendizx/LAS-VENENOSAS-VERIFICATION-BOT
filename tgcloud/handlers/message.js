import { api } from 'sdk';
import { OWNER_ID } from '../lib/config.js';

export default async function (message) {
  if (!message?.chat || !message?.from || message.chat.type !== 'private') return;
  const text = String(message.text || '').trim();
  if (text === '/start' || text.startsWith('/start ')) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Bienvenida al proceso privado de verificacion de LAS VENENOSAS.\n\nUsa /solicitar para comenzar tu solicitud.\n\nTus evidencias seran revisadas de forma privada por el equipo autorizado.'
    });
  }
}
