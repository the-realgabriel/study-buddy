import { unzipSync, strFromU8 } from "fflate";
import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";
import { createConnection } from "mysql2/promise";

interface Env {
  HYPERDRIVE: Hyperdrive;
  ASSETS: Fetcher;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  REGISTRATION_CODE?: string;
}

type Conn = Awaited<ReturnType<typeof createConnection>>;
type Dict = Record<string, any>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const OPENROUTER_FREE_FALLBACKS = [
  "xingchen-agi/xing4.0-29b-a4b:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "dots-studio/dots-3-note-preview:free",
];
const PBKDF2_ITERATIONS = 150_000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 25 * 1024 * 1024;
const MAX_NOTE_CHARS = 60000;
const QUESTION_TYPES = ["multiple_choice", "true_false", "short_answer"];

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
  "have", "has", "had", "not", "but", "you", "your", "they", "their", "its",
  "into", "than", "then", "when", "where", "which", "while", "what", "who",
  "how", "why", "can", "could", "would", "should", "will", "shall", "may",
  "might", "must", "about", "over", "under", "between", "within", "without",
  "also", "such", "each", "more", "most", "some", "any", "all", "both",
  "one", "two", "three", "been", "being", "does", "did", "doing", "there",
]);

class ApiError extends Error {
  status: number;
  authRequired: boolean;
  constructor(status: number, message: string, authRequired = false) {
    super(message);
    this.status = status;
    this.authRequired = authRequired;
  }
}

function json(data: Dict, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hashPassword(password: string, existingSaltHex?: string): Promise<string> {
  const saltHex = existingSaltHex || toHex(crypto.getRandomValues(new Uint8Array(16)));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex) as unknown as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `${saltHex}:${toHex(new Uint8Array(bits))}`;
}

function randomToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function openConn(env: Env): Promise<Conn> {
  const conn = await createConnection({
    host: env.HYPERDRIVE.host,
    port: env.HYPERDRIVE.port,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
  });
  return conn;
}

async function qRows(conn: any, sql: string, params: any[] = []): Promise<any[]> {
  const [rows] = await conn.query(sql, params);
  return rows as any[];
}

async function qRun(conn: any, sql: string, params: any[] = []): Promise<{ insertId: number }> {
  const [result]: any = await conn.query(sql, params);
  return { insertId: result.insertId ?? 0 };
}

async function withTx(conn: any, fn: (c: any) => Promise<void>): Promise<void> {
  await conn.beginTransaction();
  try {
    await fn(conn);
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  }
}

function parseJSONObject(text: unknown): Dict {
  if (typeof text !== "string" || !text) throw new Error("empty model response");
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  }
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object") return direct;
  } catch {}
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (!depth) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  throw new Error("invalid JSON from model");
}

interface HttpFailure extends Error {
  status: number;
  detail: string;
}

async function sendChat(baseUrl: string, key: string, payload: Dict): Promise<any> {
  const res = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "User-Agent": "study-buddy/1.0",
      "HTTP-Referer": "https://study-buddy.theopgabrie.workers.dev",
      "X-Title": "Study Buddy",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const err = new Error("provider http error") as HttpFailure;
    err.status = res.status;
    err.detail = await res.text().catch(() => "");
    throw err;
  }
  return res.json();
}

async function llmChat(env: Env, messages: any[], jsonMode = true): Promise<string> {
  const key = env.LLM_API_KEY || "";
  if (!key) throw new ApiError(400, "The server has no API key configured yet. Ask the administrator to set LLM_API_KEY.");
  const baseUrl = String(env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const primaryModel = env.LLM_MODEL || DEFAULT_MODEL;
  const candidates = [primaryModel];
  if (/openrouter\.ai/.test(baseUrl) && primaryModel.endsWith(":free")) {
    for (const fallback of OPENROUTER_FREE_FALLBACKS) {
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }
  }
  let lastError = new ApiError(502, "Could not generate a response from the provider.");

  for (const model of candidates) {
    const payload: Dict = { model, messages, temperature: 0.4 };
    if (jsonMode) payload.response_format = { type: "json_object" };
    let result: any;
    let retryNoFormat = false;
    let continueToNext = false;

    try {
      try {
        result = await sendChat(baseUrl, key, payload);
      } catch (err) {
        const he = err as HttpFailure;
        if (he.status === 400 && jsonMode) {
          retryNoFormat = true;
        } else if (he.status === 401) {
          throw new ApiError(502, "The server API key was rejected. Tell the administrator.");
        } else if ([429, 502, 503, 504].includes(he.status) && candidates.length > 1) {
          lastError = new ApiError(
            he.status,
            "Rate limited by the provider. Free models have tight limits; wait a minute and try again."
          );
          continueToNext = true;
        } else if (he.status === 429) {
          throw new ApiError(
            429,
            "Rate limited by the provider. Free models have tight limits; wait a minute and try again."
          );
        } else {
          throw new ApiError(502, `Provider error ${he.status}: ${(he.detail || "").slice(0, 400)}`);
        }
      }
      if (retryNoFormat) {
        delete payload.response_format;
        result = await sendChat(baseUrl, key, payload);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!(err as HttpFailure).status) {
        lastError = new ApiError(504, "The provider timed out. Try fewer questions or a smaller note.");
        continueToNext = candidates.length > 1;
        if (!continueToNext) throw lastError;
      }
    }
    if (continueToNext) continue;

    const content = result?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content) return content;
    lastError = new ApiError(502, "Unexpected response from the provider.");
  }
  throw lastError;
}

function deriveTitle(content: string, fallback = "Untitled note"): string {
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 80);
  }
  return fallback;
}

function coerceBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1", "correct"].includes(lowered)) return true;
    if (["false", "f", "no", "n", "0", "incorrect"].includes(lowered)) return false;
  }
  return null;
}

function coerceChoice(value: unknown, options: string[]): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value < options.length ? value : null;
  }
  if (typeof value === "number" && Number.isInteger(Math.round(value))) {
    const idx = Math.round(value);
    return idx >= 0 && idx < options.length ? idx : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      const index = parseInt(text, 10);
      return index >= 0 && index < options.length ? index : null;
    }
    if (text.length === 1 && "ABCDEF".includes(text.toUpperCase())) {
      const index = text.toUpperCase().charCodeAt(0) - 65;
      return index < options.length ? index : null;
    }
    const index = options.findIndex((option) => option.trim().toLowerCase() === text.toLowerCase());
    if (index !== -1) return index;
  }
  return null;
}

function normalizeQuestion(raw: unknown): Dict | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Dict;
  let qtype = String(item.type ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
  const aliases: Dict = {
    mcq: "multiple_choice",
    multiplechoice: "multiple_choice",
    multiple_choice: "multiple_choice",
    choice: "multiple_choice",
    tf: "true_false",
    truefalse: "true_false",
    true_false: "true_false",
    boolean: "true_false",
    short: "short_answer",
    shortanswer: "short_answer",
    short_answer: "short_answer",
    open: "short_answer",
    open_ended: "short_answer",
  };
  qtype = aliases[qtype];
  if (!QUESTION_TYPES.includes(qtype)) return null;
  const question = String(item.question || item.prompt || "").trim();
  if (!question) return null;
  const explanation = String(item.explanation || item.rationale || item.why || "").trim();
  const answerRaw = item.answer !== undefined ? item.answer : item.correct_answer !== undefined ? item.correct_answer : item.correct;

  if (qtype === "multiple_choice") {
    const source = item.options || item.choices || [];
    if (!Array.isArray(source)) return null;
    const options = source.map((opt: any) => String(opt).trim()).filter(Boolean);
    if (options.length < 2) return null;
    const trimmed = options.slice(0, 6);
    const answer = coerceChoice(answerRaw, trimmed);
    if (answer === null) return null;
    return {
      type: qtype,
      question: question.slice(0, 2000),
      options: trimmed.map((opt: string) => opt.slice(0, 500)),
      answer,
      explanation: explanation.slice(0, 2000),
    };
  }

  if (qtype === "true_false") {
    const answer = coerceBool(answerRaw);
    if (answer === null) return null;
    return {
      type: qtype,
      question: question.slice(0, 2000),
      answer,
      explanation: explanation.slice(0, 2000),
    };
  }

  const answer = String(answerRaw ?? "").trim();
  if (!answer) return null;
  return {
    type: qtype,
    question: question.slice(0, 2000),
    answer: answer.slice(0, 2000),
    explanation: explanation.slice(0, 2000),
  };
}

function buildQuizMessages(note: Dict, count: number, difficulty: string, types: string[]): any[] {
  const typeLabels: Dict = {
    multiple_choice: "multiple choice",
    true_false: "true/false",
    short_answer: "short answer",
  };
  const wanted = types.map((t) => typeLabels[t]).join(", ");
  const system = [
    "You are an expert tutor who writes fair, high-quality quizzes.",
    "Rules:",
    "- Use ONLY the provided notes. Never rely on outside knowledge.",
    "- Every question must be answerable from the notes alone.",
    "- Avoid trick questions, ambiguity, and duplicates.",
    "- Keep questions clear and concise.",
    "- Return ONLY a JSON object with no markdown fences and no commentary.",
    "",
    "JSON schema:",
    "{",
    '  "title": "short quiz title",',
    '  "questions": [',
    '    {"type": "multiple_choice", "question": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explanation": "..."},',
    '    {"type": "true_false", "question": "...", "answer": true, "explanation": "..."},',
    '    {"type": "short_answer", "question": "...", "answer": "expected answer", "explanation": "..."}',
    "  ]",
    "}",
    "For multiple_choice, answer is the zero-based index of the correct option.",
    "Use exactly 4 options per multiple-choice question.",
  ].join("\n");
  const user = [
    `Notes title: ${note.title}`,
    `Difficulty: ${difficulty}`,
    `Allowed question types: ${wanted}`,
    `Create exactly ${count} questions. Mix the allowed types evenly when possible.`,
    "",
    "Notes:",
    "---",
    String(note.content).slice(0, MAX_NOTE_CHARS),
    "---",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function generateQuiz(env: Env, note: Dict, count: number, difficulty: string, types: string[]): Promise<Dict> {
  const content = await llmChat(env, buildQuizMessages(note, count, difficulty, types));
  let raw: unknown;
  try {
    raw = parseJSONObject(content);
  } catch (exc) {
    throw new ApiError(502, `Could not parse the generated quiz: ${exc}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new ApiError(502, "The model returned an unexpected quiz format. Try again.");
  }
  const source = (raw as Dict).questions || [];
  const questions = source.map(normalizeQuestion).filter(Boolean);
  if (!questions.length) {
    throw new ApiError(502, "The model did not return any valid questions. Try again.");
  }
  const title = String((raw as Dict).title || `Quiz: ${note.title}`).trim().slice(0, 120);
  return { title, questions: questions.slice(0, count) };
}

function sanitizeQuiz(quizId: number, quiz: Dict, noteId: number): Dict {
  return {
    id: quizId,
    note_id: noteId,
    title: quiz.title,
    questions: quiz.questions.map((q: Dict, index: number) => {
      const out: Dict = { id: index, type: q.type, question: q.question };
      if (q.type === "multiple_choice") out.options = q.options;
      return out;
    }),
  };
}

function keywordMatch(expected: string, given: string): boolean {
  const expectedClean = String(expected).trim().toLowerCase();
  const givenClean = String(given).trim().toLowerCase();
  if (!givenClean || !expectedClean) return false;
  if (expectedClean === givenClean || expectedClean.includes(givenClean) || givenClean.includes(expectedClean)) {
    return true;
  }
  const expectedTokens = new Set(
    expectedClean.match(/[a-z0-9]+/g)?.filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
  if (!expectedTokens || !expectedTokens.size) return false;
  const givenTokens = new Set(givenClean.match(/[a-z0-9]+/g));
  if (!givenTokens) return false;
  let shared = 0;
  for (const token of expectedTokens) if (givenTokens.has(token)) shared++;
  return shared / expectedTokens.size >= 0.6;
}

function keywordResult(item: Dict): Dict {
  return { index: item.index, correct: keywordMatch(item.expected, item.response), feedback: "" };
}

async function gradeShortBatch(env: Env, items: Dict[]): Promise<Dict[]> {
  if (!items.length) return [];
  const system =
    'You are a strict but fair exam grader. Grade each short answer against the ' +
    'expected answer and the question. Accept paraphrases and equivalent meaning. ' +
    'Return ONLY JSON: {"results":[{"index":0,"correct":true,"feedback":"one short sentence"}]}. ' +
    "The index must match the provided index. Grade every item.";
  const user = JSON.stringify(
    items.map((item) => ({
      index: item.index,
      question: item.question,
      expected: item.expected,
      response: item.response,
    }))
  );
  try {
    const content = await llmChat(env, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const parsed = parseJSONObject(content);
    const results: Dict = {};
    for (const entry of parsed.results || []) {
      const index = Number.parseInt(String(entry?.index), 10);
      if (!Number.isInteger(index)) continue;
      const correct = coerceBool(entry.correct);
      if (correct === null) continue;
      results[index] = { index, correct, feedback: String(entry.feedback || "").slice(0, 400) };
    }
    return items.map((item) => results[item.index] ?? keywordResult(item));
  } catch {
    return items.map(keywordResult);
  }
}

async function gradeQuiz(env: Env, quiz: Dict, answers: unknown[]): Promise<[Dict[], number]> {
  const results: Dict[] = [];
  const shortItems: Dict[] = [];
  quiz.questions.forEach((question: Dict, index: number) => {
    const given = Array.isArray(answers) && index < answers.length ? answers[index] : null;
    const entry: Dict = {
      index,
      type: question.type,
      question: question.question,
      explanation: question.explanation ?? "",
      student_answer: given,
      correct: false,
      feedback: "",
    };
    if (question.type === "multiple_choice") {
      const choice = coerceChoice(given, question.options);
      entry.correct = choice === question.answer;
      entry.student_answer = choice !== null ? question.options[choice] : "";
      entry.correct_answer = question.options[question.answer];
    } else if (question.type === "true_false") {
      const value = coerceBool(given);
      entry.correct = value === question.answer;
      entry.student_answer = value === true ? "True" : value === false ? "False" : "";
      entry.correct_answer = question.answer ? "True" : "False";
    } else {
      const text = String(given ?? "").trim();
      entry.student_answer = text;
      entry.correct_answer = question.answer;
      shortItems.push({
        index,
        question: question.question,
        expected: question.answer,
        response: text,
      });
    }
    results.push(entry);
  });

  const graded = await gradeShortBatch(env, shortItems);
  const gradedByIndex: Dict = {};
  for (const item of graded) {
    if (item && typeof item === "object" && "index" in item) gradedByIndex[item.index] = item;
  }
  for (const entry of results) {
    if (entry.type === "short_answer") {
      const match = gradedByIndex[entry.index] || {};
      entry.correct = Boolean(match.correct);
      entry.feedback = match.feedback ?? "";
    }
  }
  const score = results.filter((entry) => entry.correct).length;
  return [results, score];
}

function xmlUnescape(text: string): string {
  const map: Dict = {};
  map["&" + "amp;"] = "&";
  map["&" + "lt;"] = "<";
  map["&" + "gt;"] = ">";
  map["&" + "quot;"] = String.fromCharCode(34);
  map["&" + "apos;"] = String.fromCharCode(39);
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (m) => map[m]);
}

function base64ToBytes(encoded: string): Uint8Array {
  const bin = atob(encoded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function extractTextContent(filename: string, raw: Uint8Array): Promise<string> {
  const name = (filename || "").toLowerCase();
  if (/\.(txt|md|markdown|csv|json|log)$/.test(name)) {
    return new TextDecoder().decode(raw);
  }
  if (name.endsWith(".docx")) {
    let xml: string;
    try {
      const files = unzipSync(raw);
      const entry = files["word/document.xml"];
      if (!entry) throw new Error("missing document.xml");
      xml = strFromU8(entry);
    } catch {
      throw new ApiError(400, "Could not read that .docx file.");
    }
    xml = xml.replaceAll("</w:p>", "\n").replaceAll("<w:tab/>", "\t").replaceAll("<w:br/>", "\n");
    const text = xmlUnescape(xml.replace(/<[^>]+>/g, ""));
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }
  if (name.endsWith(".pdf")) {
    let text: string;
    try {
      const pdf = await getDocumentProxy(raw);
      const extracted = await unpdfExtract(pdf, { mergePages: true });
      text = String(extracted.text || "");
    } catch {
      throw new ApiError(400, "Could not read that PDF.");
    }
    if (!text.trim()) {
      throw new ApiError(400, "That PDF has no extractable text (it may be scanned images).");
    }
    return text;
  }
  throw new ApiError(415, "Unsupported file type. Use .txt, .md, .docx, or .pdf.");
}

function rowToNote(row: any, includeContent = true): Dict {
  const note: Dict = {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    length: String(row.content).length,
  };
  if (includeContent) note.content = row.content;
  return note;
}

interface User {
  userId: number;
  username: string;
}

async function requireUser(conn: Conn, request: Request): Promise<User> {
  const token = (request.headers.get("X-Auth-Token") || "").trim();
  if (!token) throw new ApiError(401, "Sign in to continue.", true);
  const rows = await qRows(
    conn,
    "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
    [token, now()]
  );
  if (!rows.length) throw new ApiError(401, "Your session expired. Sign in again.", true);
  return { userId: rows[0].id, username: rows[0].username };
}

async function createSession(conn: Conn, userId: number): Promise<string> {
  await qRun(conn, "DELETE FROM sessions WHERE expires_at < ?", [now()]);
  const token = randomToken();
  await qRun(
    conn,
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, userId, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString().replace(/\.\d+Z$/, "")]
  );
  return token;
}

async function listQuizzesForNote(conn: Conn, userId: number, noteId: number): Promise<Dict[]> {
  const rows = await qRows(
    conn,
    `SELECT q.id, q.title, q.questions, q.created_at,
            COUNT(a.id) AS attempt_count,
            MAX(a.score) AS best_score,
            MAX(a.total) AS best_total
     FROM quizzes q
     LEFT JOIN attempts a ON a.quiz_id = q.id
     WHERE q.note_id = ? AND q.user_id = ?
     GROUP BY q.id, q.title, q.questions, q.created_at
     ORDER BY q.created_at DESC, q.id DESC`,
    [noteId, userId]
  );
  return rows.map((q: any) => ({
    id: q.id,
    title: q.title,
    question_count: JSON.parse(String(q.questions)).length,
    created_at: q.created_at,
    attempt_count: Number(q.attempt_count),
    best_score: q.best_score === null ? null : Number(q.best_score),
    best_total: q.best_total === null ? null : Number(q.best_total),
  }));
}

async function getNote(conn: Conn, userId: number, noteId: number, includeQuizzes = true): Promise<Dict> {
  const rows = await qRows(conn, "SELECT * FROM notes WHERE id = ? AND user_id = ?", [noteId, userId]);
  if (!rows.length) throw new ApiError(404, "Note not found.");
  const note = rowToNote(rows[0]);
  if (includeQuizzes) note.quizzes = await listQuizzesForNote(conn, userId, noteId);
  return note;
}

async function getQuiz(conn: Conn, userId: number, quizId: number): Promise<Dict> {
  const rows = await qRows(
    conn,
    "SELECT q.*, n.title AS note_title FROM quizzes q JOIN notes n ON n.id = q.note_id WHERE q.id = ? AND q.user_id = ?",
    [quizId, userId]
  );
  if (!rows.length) throw new ApiError(404, "Quiz not found.");
  const row = rows[0];
  return {
    id: row.id,
    note_id: row.note_id,
    note_title: row.note_title,
    title: row.title,
    questions: JSON.parse(String(row.questions)),
    created_at: row.created_at,
  };
}

async function readJson(request: Request): Promise<Dict> {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY) throw new ApiError(413, "That file is too large (limit 25 MB).");
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(400, "Expected a JSON object.");
  }
  return data as Dict;
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  const data = method === "POST" || method === "PUT" ? await readJson(request) : {};
  const conn = await openConn(env);
  try {
    return await route(conn, env, method, path, data, request);
  } finally {
    try { await conn.end(); } catch {}
  }
}

async function route(conn: Conn, env: Env, method: string, path: string, data: Dict, request: Request): Promise<Response> {
  if (method === "GET" && path === "/api/health") {
    return json({ ok: true, mock: false, model: env.LLM_MODEL || DEFAULT_MODEL });
  }

  if (method === "POST" && path === "/api/auth/register") {
    const username = String(data.username || "").trim();
    const password = String(data.password || "");
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      throw new ApiError(400, "Username must be 3-32 letters, numbers, dashes or underscores.");
    }
    if (password.length < 8 || password.length > 128) {
      throw new ApiError(400, "Password must be 8-128 characters.");
    }
    if (env.REGISTRATION_CODE && String(data.code || "") !== env.REGISTRATION_CODE) {
      throw new ApiError(403, "Registration requires an invite code.");
    }
    const existing = await qRows(conn, "SELECT id FROM users WHERE username = ?", [username]);
    if (existing.length) throw new ApiError(409, "That username is taken.");
    const passwordHash = await hashPassword(password);
    const result = await qRun(
      conn,
      "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
      [username, passwordHash, now()]
    );
    const token = await createSession(conn, result.insertId);
    return json(
      {
        token,
        username,
        model: env.LLM_MODEL || DEFAULT_MODEL,
        registration_open: !env.REGISTRATION_CODE,
      },
      201
    );
  }

  if (method === "POST" && path === "/api/auth/login") {
    const username = String(data.username || "").trim();
    const password = String(data.password || "");
    const rows = await qRows(conn, "SELECT id, password_hash FROM users WHERE username = ?", [username]);
    if (!rows.length) throw new ApiError(401, "Wrong username or password.");
    const [saltHex, storedHash] = String(rows[0].password_hash).split(":");
    const candidateHash = await hashPassword(password, saltHex);
    if (candidateHash !== storedHash) throw new ApiError(401, "Wrong username or password.");
    const token = await createSession(conn, rows[0].id);
    return json({ token, username, model: env.LLM_MODEL || DEFAULT_MODEL });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = (request.headers.get("X-Auth-Token") || "").trim();
    if (token) await qRun(conn, "DELETE FROM sessions WHERE token = ?", [token]);
    return json({ ok: true });
  }

  const user = await requireUser(conn, request);

  if (method === "GET" && path === "/api/meta") {
    return json({
      username: user.username,
      model: env.LLM_MODEL || DEFAULT_MODEL,
      has_key: Boolean(env.LLM_API_KEY),
      registration_open: !env.REGISTRATION_CODE,
    });
  }

  if (method === "GET" && path === "/api/notes") {
    const rows = await qRows(
      conn,
      `SELECT n.id, n.title, n.created_at, n.updated_at, n.content, COUNT(q.id) AS quiz_count
       FROM notes n
       LEFT JOIN quizzes q ON q.note_id = n.id AND q.user_id = n.user_id
       WHERE n.user_id = ?
       GROUP BY n.id, n.title, n.created_at, n.updated_at, n.content
       ORDER BY n.updated_at DESC`,
      [user.userId]
    );
    const notes = rows.map((row: any) => ({ ...rowToNote(row, false), quiz_count: Number(row.quiz_count) }));
    return json({ notes });
  }

  if (method === "POST" && path === "/api/notes") {
    const content = String(data.content || "").trim();
    if (!content) throw new ApiError(400, "Note content is empty.");
    if (content.length > MAX_NOTE_CHARS) {
      throw new ApiError(413, `Note is too long (limit ${MAX_NOTE_CHARS} characters).`);
    }
    const title = String(data.title || "").trim().slice(0, 120) || deriveTitle(content);
    const stamp = now();
    const result = await qRun(
      conn,
      "INSERT INTO notes (user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [user.userId, title, content, stamp, stamp]
    );
    return json(await getNote(conn, user.userId, result.insertId), 201);
  }

  let match = path.match(/^\/api\/notes\/(\d+)$/);
  if (match) {
    const noteId = Number(match[1]);
    if (method === "GET") return json(await getNote(conn, user.userId, noteId));
    if (method === "PUT") {
      const note = await getNote(conn, user.userId, noteId, false);
      const content = String(data.content ?? note.content).trim();
      if (!content) throw new ApiError(400, "Note content is empty.");
      if (content.length > MAX_NOTE_CHARS) {
        throw new ApiError(413, `Note is too long (limit ${MAX_NOTE_CHARS} characters).`);
      }
      const title = String(data.title ?? note.title).trim().slice(0, 120) || deriveTitle(content);
      await qRun(
        conn,
        "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        [title, content, now(), noteId, user.userId]
      );
      return json(await getNote(conn, user.userId, noteId));
    }
    if (method === "DELETE") {
      await withTx(conn, async (c) => {
        await qRun(
          c,
          "DELETE FROM attempts WHERE user_id = ? AND quiz_id IN (SELECT id FROM (SELECT id FROM quizzes WHERE note_id = ? AND user_id = ?) AS q)",
          [user.userId, noteId, user.userId]
        );
        await qRun(c, "DELETE FROM quizzes WHERE note_id = ? AND user_id = ?", [noteId, user.userId]);
        await qRun(c, "DELETE FROM notes WHERE id = ? AND user_id = ?", [noteId, user.userId]);
      });
      return json({ ok: true });
    }
  }

  match = path.match(/^\/api\/notes\/(\d+)\/generate$/);
  if (method === "POST" && match) {
    const note = await getNote(conn, user.userId, Number(match[1]));
    const count = Math.max(1, Math.min(Number.parseInt(String(data.count || 8), 10) || 8, 20));
    let difficulty = String(data.difficulty || "medium").toLowerCase();
    if (!["easy", "medium", "hard"].includes(difficulty)) difficulty = "medium";
    let types: string[] = Array.isArray(data.types) ? data.types : [...QUESTION_TYPES];
    types = types.filter((t) => QUESTION_TYPES.includes(t));
    if (!types.length) types = [...QUESTION_TYPES];
    const quiz = await generateQuiz(env, note, count, difficulty, types);
    const result = await qRun(
      conn,
      "INSERT INTO quizzes (user_id, note_id, title, questions, created_at) VALUES (?, ?, ?, ?, ?)",
      [user.userId, note.id, quiz.title, JSON.stringify(quiz.questions), now()]
    );
    return json(sanitizeQuiz(result.insertId, quiz, note.id), 201);
  }

  match = path.match(/^\/api\/quizzes\/(\d+)$/);
  if (match) {
    const quizId = Number(match[1]);
    if (method === "GET") {
      const quiz = await getQuiz(conn, user.userId, quizId);
      return json(sanitizeQuiz(quiz.id, quiz, quiz.note_id));
    }
    if (method === "DELETE") {
      const owned = await qRows(conn, "SELECT id FROM quizzes WHERE id = ? AND user_id = ?", [quizId, user.userId]);
      if (!owned.length) throw new ApiError(404, "Quiz not found.");
      await withTx(conn, async (c) => {
        await qRun(c, "DELETE FROM attempts WHERE quiz_id = ? AND user_id = ?", [quizId, user.userId]);
        await qRun(c, "DELETE FROM quizzes WHERE id = ? AND user_id = ?", [quizId, user.userId]);
      });
      return json({ ok: true });
    }
  }

  match = path.match(/^\/api\/quizzes\/(\d+)\/submit$/);
  if (method === "POST" && match) {
    const quiz = await getQuiz(conn, user.userId, Number(match[1]));
    const answers = data.answers;
    if (!Array.isArray(answers)) throw new ApiError(400, "Answers must be a list.");
    const [results, score] = await gradeQuiz(env, quiz, answers);
    const result = await qRun(
      conn,
      "INSERT INTO attempts (user_id, quiz_id, score, total, results, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [user.userId, quiz.id, score, results.length, JSON.stringify(results), now()]
    );
    return json({
      attempt_id: result.insertId,
      quiz_id: quiz.id,
      quiz_title: quiz.title,
      note_id: quiz.note_id,
      note_title: quiz.note_title,
      score,
      total: results.length,
      results,
    });
  }

  if (method === "GET" && path === "/api/attempts") {
    const rows = await qRows(
      conn,
      `SELECT a.id, a.quiz_id, a.score, a.total, a.created_at,
              q.title AS quiz_title, q.note_id, n.title AS note_title
       FROM attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       JOIN notes n ON n.id = q.note_id
       WHERE a.user_id = ?
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 100`,
      [user.userId]
    );
    return json({ attempts: rows });
  }

  match = path.match(/^\/api\/attempts\/(\d+)$/);
  if (method === "GET" && match) {
    const rows = await qRows(
      conn,
      `SELECT a.*, q.title AS quiz_title, q.note_id, n.title AS note_title
       FROM attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       JOIN notes n ON n.id = q.note_id
       WHERE a.id = ? AND a.user_id = ?`,
      [Number(match[1]), user.userId]
    );
    if (!rows.length) throw new ApiError(404, "Attempt not found.");
    const row = rows[0];
    return json({
      attempt_id: row.id,
      quiz_id: row.quiz_id,
      quiz_title: row.quiz_title,
      note_id: row.note_id,
      note_title: row.note_title,
      score: row.score,
      total: row.total,
      results: JSON.parse(String(row.results)),
      created_at: row.created_at,
    });
  }

  if (method === "POST" && path === "/api/extract") {
    const encoded = String(data.data || "");
    if (!encoded) throw new ApiError(400, "No file data received.");
    let raw: Uint8Array;
    try {
      raw = base64ToBytes(encoded);
    } catch {
      throw new ApiError(400, "Could not decode the uploaded file.");
    }
    if (raw.length > 15 * 1024 * 1024) {
      throw new ApiError(413, "That file is too large (limit 15 MB).");
    }
    const text = await extractTextContent(String(data.filename || ""), raw);
    return json({ text: text.slice(0, MAX_NOTE_CHARS), truncated: text.length > MAX_NOTE_CHARS });
  }

  throw new ApiError(404, "Not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        if (err instanceof ApiError) {
          const body: Dict = { error: err.message };
          if (err.authRequired) body.auth_required = true;
          return json(body, err.status);
        }
        console.error("Unhandled error:", err);
        return json({ error: `Unexpected server error: ${err}` }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
