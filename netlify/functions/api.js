// netlify/functions/api.js
// Menggantikan cekKodeAkses() dan getQuestions() versi Apps Script.
// Pakai Node fetch bawaan (tidak butuh npm install apapun).

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

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
  if (!res.ok) {
    throw new Error("Airtable error: " + JSON.stringify(data));
  }
  return data;
}

function escapeForFormula(s) {
  return String(s).replace(/'/g, "\\'");
}

async function findAccessCodeByKode(kode) {
  const formula = encodeURIComponent(`{Kode}='${escapeForFormula(kode)}'`);
  const data = await airtableRequest(`AccessCodes?filterByFormula=${formula}`);
  return data.records && data.records.length > 0 ? data.records[0] : null;
}

async function updateAccessCode(recordId, fields) {
  return airtableRequest(`AccessCodes/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields }),
  });
}

async function fetchAllQuestions() {
  let all = [];
  let offset;
  do {
    const qs = offset ? `Questions?offset=${offset}` : `Questions`;
    const data = await airtableRequest(qs);
    all = all.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return all;
}

function ekstrakNamaBab(judulLengkap) {
  const parts = String(judulLengkap || "").split(/—|–|-{1,2}/);
  return parts[parts.length - 1].trim();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function handleCekKodeAkses(body) {
  const kode = String(body.kode || "").trim().toUpperCase();
  const email = String(body.email || "").trim().toLowerCase();

  if (!kode || !email) {
    return { sukses: false, pesan: "Kode & email wajib diisi" };
  }

  const record = await findAccessCodeByKode(kode);
  if (!record) {
    return { sukses: false, pesan: "Kode tidak ditemukan" };
  }

  const f = record.fields;
  const status = f.Status || "";
  const emailDb = String(f.Pembeli || "").trim().toLowerCase();

  if (status === "TERPAKAI" && emailDb && emailDb !== email) {
    return { sukses: false, pesan: "Kode sudah digunakan akun lain" };
  }

  const updateFields = {
    Status: "TERPAKAI",
    Pembeli: email,
    TerakhirAkses: new Date().toISOString(),
  };
  if (!f.TanggalAktivasi) {
    updateFields.TanggalAktivasi = new Date().toISOString();
  }
  await updateAccessCode(record.id, updateFields);

  return { sukses: true, pesan: "Akses berhasil", produk: f.Produk };
}

async function handleGetQuestions(body) {
  const namaProduk = String(body.namaProduk || "");
  const produkInputFull = namaProduk.trim().toLowerCase();
  const produkInputBab = ekstrakNamaBab(namaProduk).toLowerCase();

  const records = await fetchAllQuestions();
  const list = [];
  records.forEach((r) => {
    const f = r.fields;
    const produkRow = String(f.Produk || "").trim().toLowerCase();
    if (produkRow === produkInputFull || produkRow === produkInputBab) {
      list.push({
        level: f.Level,
        kategori: f.Kategori,
        question: f.Question,
        options: [f.OptionA, f.OptionB, f.OptionC, f.OptionD],
        answer: Number(f.Answer),
        explanation: f.Explanation,
      });
    }
  });

  return { questions: shuffle(list) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    let result;
    if (body.action === "cekKodeAkses") {
      result = await handleCekKodeAkses(body);
    } else if (body.action === "getQuestions") {
      result = await handleGetQuestions(body);
    } else {
      result = { error: "Unknown action: " + body.action };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
