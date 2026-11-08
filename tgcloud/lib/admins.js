import { db } from 'sdk';
import { eq } from 'sdk/db';
import { verificationAdmins } from '../schema.js';
import { OWNER_ID } from './config.js';

// El Owner siempre está autorizado. Los demás deben existir en la lista persistente.
export async function isVerificationAdmin(telegramId) {
  const id = Number(telegramId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (id === Number(OWNER_ID)) return true;
  const row = await db.select().from(verificationAdmins)
    .where(eq(verificationAdmins.telegramId, id)).get();
  return Boolean(row);
}
