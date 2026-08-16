// netlify/functions/webhook.js
// Menerima webhook Lynk.id, verifikasi signature (BENERAN BISA di Netlify,
// beda dengan Apps Script yang tidak bisa baca header HTTP kustom),
// generate kode akses otomatis, simpan ke Airtable, kirim email via Resend.

const crypto = require("crypto");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

const LYNK_MERCHANT_KEY = process.env.LYNK_MERCHANT_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "MindArcade <onboarding@resend.dev>";

async function airtableRequest(path, options = {}) {
  const res = await fetch(`${AT_BASE_URL}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Airtable error: " + JSON.stringify(data));
  return data;
}

function escapeForFormula(s) {
  return String(s).replace(/'/g, "\\'");
}

function buatKodeUntukProduk(namaProduk) {
  const prefix = (String(namaProduk).replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase()) || "MND";
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `MND-${prefix}-${random}`;
}

async function sudahDiprosesSebelumnya(messageId) {
  if (!messageId) return false;
  const formula = encodeURIComponent(`{MessageID}='${escapeForFormula(messageId)}'`);
  const data = await airtableRequest(`ProcessedWebhooks?filterByFormula=${formula}`);
  return data.records && data.records.length > 0;
}

async function catatWebhookSelesai(messageId) {
  await airtableRequest("ProcessedWebhooks", {
    method: "POST",
    body: JSON.stringify({ fields: { MessageID: messageId, ProcessedAt: new Date().toISOString() } }),
  });
}

async function catatDebug(rawBody, headers, catatan) {
  try {
    await airtableRequest("WebhookDebug", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          Waktu: new Date().toISOString(),
          RawBody: String(rawBody).substring(0, 90000),
          Headers: JSON.stringify(headers || {}).substring(0, 20000),
          Catatan: catatan || "",
        },
      }),
    });
  } catch (e) {
    console.error("Gagal catat debug:", e);
  }
}

async function kirimEmail(email, nama, kodeList) {
  const subjek = "Kode Akses MindArcade Kamu 🧠";
  let html = `<p>Halo ${nama},</p><p>Terima kasih sudah membeli di MindArcade! Berikut kode aksesmu:</p><ul>`;
  kodeList.forEach((k) => {
    html += `<li><b>${k.produk}</b>: <code>${k.kode}</code></li>`;
  });
  html += "</ul><p>Cara pakai: buka Web App MindArcade, masukkan kode & email di atas, klik Mulai Belajar.</p><p>Selamat belajar!</p>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: subjek,
      html,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Resend error: " + t);
  }
}

function verifikasiSignature(headers, amount, refId, messageId) {
  const signatureHeader = (headers && (headers["x-lynk-signature"] || headers["X-Lynk-Signature"])) || "";
  if (!signatureHeader || !LYNK_MERCHANT_KEY) {
    return { ok: false, reason: "header atau merchant key kosong", signatureHeader: signatureHeader };
  }
  const signatureString = String(amount) + refId + messageId + LYNK_MERCHANT_KEY;
  const computed = crypto.createHash("sha256").update(signatureString).digest("hex");
  return { ok: computed === signatureHeader, computed, received: signatureHeader, signatureString };
}

exports.handler = async (event) => {
  const rawBody = event.body || "";
  let body;

  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    await catatDebug(rawBody, event.headers, "GAGAL PARSE JSON: " + String(e));
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "invalid json" }) };
  }

  await catatDebug(rawBody, event.headers, "diterima");

  try {
    if (body.event !== "payment.received") {
      return { statusCode: 200, body: JSON.stringify({ ok: true, info: "event diabaikan: " + body.event }) };
    }

    const dataWrap = body.data || {};
    const md = dataWrap.message_data || {};
    const messageId = dataWrap.message_id || "";
    const messageAction = dataWrap.message_action || "";

    if (messageAction !== "SUCCESS") {
      return { statusCode: 200, body: JSON.stringify({ ok: true, info: "message_action bukan SUCCESS" }) };
    }

    const amount = md.totals ? md.totals.grandTotal : "";
    const refId = md.refId || "";
    const sigCheck = verifikasiSignature(event.headers, amount, refId, messageId);
    await catatDebug(rawBody, event.headers, "Cek signature: " + JSON.stringify(sigCheck));
    // CATATAN: untuk sekarang signature TIDAK memblokir proses (masih tahap
    // verifikasi field 'amount' yang benar). Begitu terbukti cocok lewat
    // pengetesan nyata, ubah baris di bawah ini jadi hard block kalau !ok.

    if (await sudahDiprosesSebelumnya(messageId)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, info: "sudah pernah diproses" }) };
    }

    const customerEmail = (md.customer && md.customer.email) || "";
    const customerName = (md.customer && md.customer.name) || "Pelanggan";
    const items = md.items || [];

    const kodeList = [];
    for (const item of items) {
      const kode = buatKodeUntukProduk(item.title);
      await airtableRequest("AccessCodes", {
        method: "POST",
        body: JSON.stringify({ fields: { Kode: kode, Produk: item.title, Status: "AKTIF" } }),
      });
      kodeList.push({ produk: item.title, kode });
    }

    if (kodeList.length > 0 && customerEmail) {
      await kirimEmail(customerEmail, customerName, kodeList);
    }

    await catatWebhookSelesai(messageId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, kodeList, signature: sigCheck }) };
  } catch (err) {
    await catatDebug(rawBody, event.headers, "ERROR: " + String(err));
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
