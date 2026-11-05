const TELEGRAM_API = "https://api.telegram.org";

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function telegram(method, payload) {
  const token = getEnv("BOT_TOKEN");
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram API error: ${method}`);
  }
  return result.result;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message?.text || !message.from) return;

  const text = message.text.trim();
  const chatId = message.chat?.id;
  const ownerId = Number(getEnv("OWNER_ID"));

  if (text === "/start" || text.startsWith("/start ")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "👋 Bienvenida al sistema privado de verificación de LAS VENENOSAS.\n\nPróximamente podrás iniciar tu solicitud y enviar tus evidencias aquí."
    });
    return;
  }

  if (text === "/testtema") {
    if (message.chat?.type !== "private" || Number(message.from.id) !== ownerId) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "⛔ Este comando está reservado para el propietario del bot."
      });
      return;
    }

    const groupId = getEnv("VERIFY_GROUP_ID");
    const username = message.from.username ? `@${message.from.username}` : `ID ${message.from.id}`;
    const topic = await telegram("createForumTopic", {
      chat_id: groupId,
      name: `🧪 PRUEBA DE CONEXIÓN · ${username}`
    });

    await telegram("sendMessage", {
      chat_id: groupId,
      message_thread_id: topic.message_thread_id,
      text: [
        "🧪 PRUEBA DE CONEXIÓN",
        "",
        "El bot pudo crear este tema y enviar un mensaje.",
        `Solicitante de la prueba: ${username}`,
        `ID de tema: ${topic.message_thread_id}`,
        "Este tema es de prueba; todavía no contiene evidencias de una modelo."
      ].join("\n")
    });

    await telegram("sendMessage", {
      chat_id: chatId,
      text: `✅ Conexión correcta. Se creó el tema de prueba en el grupo de verificaciones.\nID del tema: ${topic.message_thread_id}`
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const expectedSecret = getEnv("WEBHOOK_SECRET");
    const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];

    if (!receivedSecret || receivedSecret !== expectedSecret) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized webhook" });
    }

    const update = req.body && typeof req.body === "object"
      ? req.body
      : await new Promise((resolve, reject) => {
          let raw = "";
          req.on("data", chunk => { raw += chunk; });
          req.on("end", () => {
            try { resolve(raw ? JSON.parse(raw) : {}); }
            catch (error) { reject(error); }
          });
          req.on("error", reject);
        });

    await handleUpdate(update);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
}
