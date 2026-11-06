import { table, integer, text, index } from 'sdk/db';

// Expediente principal: no almacenar aquí el contenido de las evidencias,
// solo sus referencias privadas de Telegram y el estado de revisión.
export const verificationRequests = table('verification_requests', {
  id: text('id').primaryKey(),
  telegramId: integer('telegram_id').notNull(),
  username: text('username').notNull().default(''),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  status: text('status').notNull().default('INICIADA'),
  topicId: integer('topic_id'),
  ageDeclared: integer('age_declared'),
  nationality: text('nationality').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  reviewedBy: integer('reviewed_by'),
  reviewedAt: integer('reviewed_at'),
}, t => ({
  telegramIdx: index('idx_verification_requests_telegram').on(t.telegramId),
  statusIdx: index('idx_verification_requests_status').on(t.status),
  topicIdx: index('idx_verification_requests_topic').on(t.topicId),
}));

// Una fila por evidencia. file_id/file_unique_id se mantienen en la BD privada.
export const verificationEvidence = table('verification_evidence', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  evidenceType: text('evidence_type').notNull(),
  telegramFileId: text('telegram_file_id').notNull().default(''),
  telegramFileUniqueId: text('telegram_file_unique_id').notNull().default(''),
  messageId: integer('message_id'),
  submittedAt: integer('submitted_at').notNull(),
  reviewStatus: text('review_status').notNull().default('PENDIENTE'),
}, t => ({
  requestIdx: index('idx_verification_evidence_request').on(t.requestId),
}));

// Administradores autorizados para revisar expedientes.
export const verificationAdmins = table('verification_admins', {
  telegramId: integer('telegram_id').primaryKey(),
  addedBy: integer('added_by').notNull(),
  createdAt: integer('created_at').notNull(),
});

// Registro de acciones administrativas y cambios de estado.
export const verificationAudit = table('verification_audit', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  actorTelegramId: integer('actor_telegram_id'),
  action: text('action').notNull(),
  details: text('details').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
}, t => ({
  requestIdx: index('idx_verification_audit_request').on(t.requestId),
  actorIdx: index('idx_verification_audit_actor').on(t.actorTelegramId),
}));

// Relación persistente entre el expediente y el tema del grupo privado.
export const verificationTopics = table('verification_topics', {
  requestId: text('request_id').primaryKey(),
  groupId: integer('group_id').notNull(),
  topicId: integer('topic_id').notNull(),
  createdAt: integer('created_at').notNull(),
});


// Estado conversacional persistente para continuar solicitudes entre mensajes.
export const verificationSessions = table('verification_sessions', {
  telegramId: integer('telegram_id').primaryKey(),
  requestId: text('request_id').notNull(),
  step: text('step').notNull(),
  updatedAt: integer('updated_at').notNull(),
});


// Plantillas editables de los mensajes del proceso de verificación.
export const verificationTemplates = table('verification_templates', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull(),
});
