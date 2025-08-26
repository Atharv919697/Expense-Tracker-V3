// WhatsApp Expense Bot (free-form) running alongside n8n in one service.
// Locks to GROUP_JID. Posts to n8n via N8N_WEBHOOK_URL. Processes your messages too.

import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import axios from "axios";

// ENV
const GROUP_JID = (process.env.GROUP_JID || "").trim();       // e.g. 120363419674431478@g.us
const N8N_WEBHOOK_URL = (process.env.N8N_WEBHOOK_URL || "").trim();

console.log("[BOT] GROUP_JID:", GROUP_JID || "(NOT set — discovery mode only)");
console.log("[BOT] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL ? "(set)" : "(not set — skipping POSTs)");

// free-form parser: take LAST amount as price, rest is item
function parseExpense(rawText) {
  if (!rawText) return null;
  const text = rawText.toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) last = m[1];
  if (!last) return null;

  const price = parseFloat(last.replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;

  const item = text
    .replace(last, " ")
    .replace(/\b(rs|inr|rupees)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "misc";

  return { item, price };
}

function extractText(msg) {
  const m  = msg.message || {};
  const em = m.ephemeralMessage?.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    em.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    em.imageMessage?.caption ||
    em.videoMessage?.caption ||
    ""
  );
}

async function startBot() {
  // For persistence across restarts, later mount a Disk and change to "/data/auth_info"
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["WaExpenseBot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("[BOT] Scan QR → WhatsApp › Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("[BOT] ✅ WhatsApp connected!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg  = lastDisconnect?.error?.message || code;
      console.log("[BOT] 🔌 Connection closed:", msg);
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log("[BOT] Logged out. Delete auth_info then redeploy to relink.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg || !msg.message) return;

    const jid = String(msg.key.remoteJid || "");
    if (jid === "status@broadcast") return;
    if (!jid.endsWith("@g.us")) return;          // groups only

    if (!GROUP_JID) { // discovery mode
      console.log(`[BOT] [DISCOVER] Group message from: ${jid} — set GROUP_JID to this value and redeploy.`);
      return;
    }
    if (jid !== GROUP_JID) return;

    const text = extractText(msg);
    if (!text || !text.trim()) return;

    // Anti-loop: ignore our own confirmation if forwarded/quoted
    if (/^\s*✅\s*added:/i.test(text)) return;

    const senderName = msg.pushName || "Unknown";
    const parsed = parseExpense(text);
    if (!parsed) return;

    const payload = {
      name: senderName,
      item: parsed.item,
      price: parsed.price,
      jid,
      raw: text,
      ts: Number(msg.messageTimestamp) * 1000,
    };

    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
      } catch (e) {
        console.log("[BOT] n8n webhook error:", e?.response?.status, e?.message);
      }
    }

    await sock.sendMessage(jid, {
      text: `✅ added:  · ${payload.name} ${payload.item} · ₹${payload.price}`
    });
  });
}

startBot().catch(err => console.error("[BOT] fatal:", err));
