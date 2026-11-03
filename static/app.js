const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));

const state = {
  notes: [],
  note: null,
  quiz: null,
  results: null,
  user: null,
  model: "",
  editingId: null,
  filter: "",
};

const TOKEN_KEY = "sb_auth_token";
let authMode = "login";

const TYPE_LABELS = {
  multiple_choice: "Multiple choice",
  true_false: "True / false",
  short_answer: "Short answer",
};

const authHeader = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { "X-Auth-Token": token } : {};
};

async function api(path, options = {}) {
  const opts = { ...options, headers: { "Content-Type": "application/json", ...authHeader(), ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const response = await fetch(path, opts);
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401 && data.auth_required) {
      localStorage.removeItem(TOKEN_KEY);
      openAuthModal();
    }
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

let toastTimer;
function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 200);
  }, 4000);
}

function openModal(id) {
  $(`#${id}`).classList.remove("hidden");
}

function closeModal(id) {
  $(`#${id}`).classList.add("hidden");
}

function openAuthModal(mode = null) {
  if (mode) authMode = mode;
  const modal = $("#authModal");
  const isRegister = authMode === "register";
  $("#authTitle").textContent = isRegister ? "Create an account" : "Sign in";
  $("#authSubmitBtn").textContent = isRegister ? "Register" : "Sign in";
  $("#authToggleBtn").textContent = isRegister ? "Already registered? Sign in" : "New here? Register";
  $("#authPassLabel").textContent = "Password" + (isRegister ? " (8+ characters)" : "");
  $("#authPass").setAttribute("autocomplete", isRegister ? "new-password" : "current-password");
  $("#authCodeField").classList.toggle("hidden", !isRegister);
  $("#authError").textContent = "";
  if (!modal.contains(document.activeElement)) {
    $("#authUser").value = "";
    $("#authPass").value = "";
    $("#authCode").value = "";
  }
  modal.classList.remove("hidden");
  setTimeout(() => $("#authUser").focus(), 30);
}

function toggleAuthModal() {
  openAuthModal(authMode === "login" ? "register" : "login");
}

async function authSubmit() {
  const username = $("#authUser").value.trim();
  const password = $("#authPass").value;
  const button = $("#authSubmitBtn");
  if (!username || !password) {
    $("#authError").textContent = "Enter a username and password.";
    return;
  }
  busy(button, authMode === "login" ? "Signing in" : "Creating account");
  try {
    const body = { username, password };
    if (authMode === "register") body.code = $("#authCode").value.trim();
    const payload = await api(`/api/auth/${authMode}`, { method: "POST", body });
    localStorage.setItem(TOKEN_KEY, payload.token);
    state.user = payload.username;
    state.model = payload.model;
    $("#authModal").classList.add("hidden");
    renderPill();
    await refresh();
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    idle(button, authMode === "login" ? "Sign in" : "Register");
  }
}

async function logoutUser() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    /* session may already be gone */
  }
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.note = null;
  state.quiz = null;
  state.results = null;
  state.notes = [];
  renderNotes();
  renderEmpty();
  renderPill();
  sessionStorage.clear();
  openAuthModal("login");
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function busy(button, label) {
  button.dataset.label = button.textContent;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
}

function idle(button, fallback) {
  button.disabled = false;
  button.textContent = button.dataset.label || fallback;
}

function renderPill() {
  const pill = $("#providerPill");
  if (!state.user) {
    pill.className = "pill offline";
    pill.innerHTML = `<span class="dot"></span><span>signed out</span>`;
    return;
  }
  if (!state.model) {
    pill.className = "pill offline";
    pill.innerHTML = `<span class="dot"></span><span>no provider configured</span>`;
    return;
  }
  pill.className = "pill";
  pill.innerHTML = `<span class="dot"></span><span>${esc(state.model)} · managed</span>`;
}

async function loadMeta() {
  try {
    const meta = await api("/api/meta");
    state.user = meta.username;
    state.model = meta.has_key ? meta.model : "";
  } catch (error) {
    state.user = null;
  }
  renderPill();
}

async function loadNotes() {
  try {
    const data = await api("/api/notes");
    state.notes = data.notes;
  } catch (error) {
    state.notes = [];
    toast(error.message, "error");
  }
}

function renderNotes() {
  const list = $("#noteList");
  const query = state.filter.trim().toLowerCase();
  const notes = state.notes.filter((note) => note.title.toLowerCase().includes(query));
  if (!notes.length) {
    list.innerHTML = `<div class="empty">${state.notes.length ? "No notes match your search." : "No notes yet. Add your first note to get started."}</div>`;
    return;
  }
  list.innerHTML = notes
    .map((note) => {
      const quizzes = note.quiz_count
        ? `${note.quiz_count} quiz${note.quiz_count === 1 ? "" : "zes"} · `
        : "";
      return `
      <button class="note-item ${state.note && state.note.id === note.id ? "active" : ""}" data-id="${note.id}">
        <span class="note-title">${esc(note.title)}</span>
        <span class="note-meta">${quizzes}${note.length.toLocaleString()} chars · ${esc(formatDate(note.updated_at))}</span>
      </button>`;
    })
    .join("");
  $$(".note-item", list).forEach((button) => {
    button.addEventListener("click", () => openNote(Number(button.dataset.id)));
  });
}

function renderEmpty() {
  $("#view").innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          <path d="M9 7h7M9 11h5"></path>
        </svg>
      </div>
      <h2>Turn your notes into a quiz</h2>
      <p>Paste lecture notes, a chapter summary, or drop a file. Study Buddy writes questions from your material and tests you on it.</p>
      <button class="btn primary" id="emptyNewBtn">Add your first note</button>
    </div>`;
  $("#emptyNewBtn").addEventListener("click", () => openNoteModal());
}

function renderNoteView() {
  const note = state.note;
  if (!note) {
    renderEmpty();
    return;
  }
  const quizzes = note.quizzes || [];
  const quizzesSection = quizzes.length
    ? `
      <section class="saved-quizzes">
        <div class="section-head">
          <h3>Saved quizzes (${quizzes.length})</h3>
        </div>
        <div class="quiz-list">
          ${quizzes
            .map((q) => {
              const hasDraft = Boolean(sessionStorage.getItem(`sb_draft_${q.id}`));
              const scoreText = q.attempt_count
                ? `Best ${q.best_score}/${q.best_total} · ${q.attempt_count} attempt${q.attempt_count === 1 ? "" : "s"}`
                : hasDraft
                  ? "In progress"
                  : "Not attempted yet";
              const btnLabel = hasDraft ? "Resume quiz" : q.attempt_count ? "Retake" : "Take quiz";
              return `
                <div class="quiz-row">
                  <div class="quiz-row-main">
                    <div class="quiz-row-title">${esc(q.title)}</div>
                    <div class="quiz-row-meta">${q.question_count} questions · ${esc(scoreText)} · ${esc(formatDate(q.created_at))}</div>
                  </div>
                  <div class="quiz-row-actions">
                    <button class="btn small primary take-quiz-btn" data-id="${q.id}">${btnLabel}</button>
                    <button class="btn small ghost delete-quiz-btn" data-id="${q.id}" title="Delete quiz">Delete</button>
                  </div>
                </div>`;
            })
            .join("")}
        </div>
      </section>`
    : "";
  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <h2>${esc(note.title)}</h2>
        <div class="meta">${note.length.toLocaleString()} characters · updated ${esc(formatDate(note.updated_at))}</div>
      </div>
      <div class="actions">
        <button class="btn primary" id="genOpenBtn">Generate quiz</button>
        <button class="btn ghost" id="editNoteBtn">Edit</button>
        <button class="btn danger" id="deleteNoteBtn">Delete</button>
      </div>
    </div>
    ${quizzesSection}
    <div class="note-content">${esc(note.content)}</div>`;
  $("#genOpenBtn").addEventListener("click", openGenerator);
  $("#editNoteBtn").addEventListener("click", () => openNoteModal(note));
  $("#deleteNoteBtn").addEventListener("click", deleteCurrentNote);
  $$(".take-quiz-btn").forEach((button) => {
    button.addEventListener("click", () => retakeQuiz(Number(button.dataset.id)));
  });
  $$(".delete-quiz-btn").forEach((button) => {
    button.addEventListener("click", () => deleteQuiz(Number(button.dataset.id)));
  });
}

async function deleteQuiz(quizId) {
  if (!confirm("Delete this saved quiz and its score history?")) return;
  try {
    await api(`/api/quizzes/${quizId}`, { method: "DELETE" });
    sessionStorage.removeItem(`sb_draft_${quizId}`);
    await loadNotes();
    if (state.note) {
      await openNote(state.note.id);
    }
    toast("Quiz deleted.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function typeBadge(type) {
  return `<span class="badge">${esc(TYPE_LABELS[type] || type)}</span>`;
}

function questionCard(question, index) {
  let body = "";
  if (question.type === "multiple_choice") {
    const letters = "ABCDEF";
    body = `<div class="options">${question.options
      .map(
        (option, optionIndex) => `
        <label class="option">
          <input type="radio" name="q${index}" value="${optionIndex}">
          <span class="letter">${letters[optionIndex] || optionIndex + 1}</span>
          <span>${esc(option)}</span>
        </label>`
      )
      .join("")}</div>`;
  } else if (question.type === "true_false") {
    body = `<div class="options">
      <label class="option"><input type="radio" name="q${index}" value="true"><span class="letter">T</span><span>True</span></label>
      <label class="option"><input type="radio" name="q${index}" value="false"><span class="letter">F</span><span>False</span></label>
    </div>`;
  } else {
    body = `<textarea class="short-answer" id="short-${index}" placeholder="Type your answer"></textarea>`;
  }
  return `
    <div class="qcard">
      <div class="qmeta"><span class="qnum">Question ${index + 1}</span>${typeBadge(question.type)}</div>
      <p class="qtext">${esc(question.question)}</p>
      ${body}
    </div>`;
}

function collectDraftAnswers() {
  const quiz = state.quiz;
  if (!quiz) return [];
  return quiz.questions.map((question, index) => {
    if (question.type === "short_answer") return $(`#short-${index}`)?.value || "";
    const checked = document.querySelector(`input[name="q${index}"]:checked`);
    return checked ? checked.value : null;
  });
}

function saveDraftAnswers() {
  const quiz = state.quiz;
  if (!quiz) return;
  const draft = collectDraftAnswers();
  const hasAny = draft.some((v) => v !== null && String(v).trim() !== "");
  if (hasAny) {
    sessionStorage.setItem(`sb_draft_${quiz.id}`, JSON.stringify(draft));
  } else {
    sessionStorage.removeItem(`sb_draft_${quiz.id}`);
  }
}

function restoreDraftAnswers() {
  const quiz = state.quiz;
  if (!quiz) return;
  const raw = sessionStorage.getItem(`sb_draft_${quiz.id}`);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (!Array.isArray(draft)) return;
    quiz.questions.forEach((question, index) => {
      const val = draft[index];
      if (val === null || val === undefined || val === "") return;
      if (question.type === "short_answer") {
        const area = $(`#short-${index}`);
        if (area) area.value = String(val);
      } else {
        const input = document.querySelector(`input[name="q${index}"][value="${CSS.escape(String(val))}"]`);
        if (input) input.checked = true;
      }
    });
  } catch (error) {
    sessionStorage.removeItem(`sb_draft_${quiz.id}`);
  }
}

function updateProgress() {
  const quiz = state.quiz;
  if (!quiz) return;
  let answered = 0;
  quiz.questions.forEach((question, index) => {
    if (question.type === "short_answer") {
      if (($(`#short-${index}`)?.value || "").trim()) answered += 1;
    } else if (document.querySelector(`input[name="q${index}"]:checked`)) {
      answered += 1;
    }
  });
  const fill = $("#progressFill");
  const label = $("#progressLabel");
  if (fill) fill.style.width = `${(answered / quiz.questions.length) * 100}%`;
  if (label) label.textContent = `${answered} of ${quiz.questions.length} answered`;
  saveDraftAnswers();
}

function startQuiz(quiz) {
  state.quiz = quiz;
  state.results = null;
  renderQuiz();
  $(".main").scrollTop = 0;
}

function renderQuiz() {
  const quiz = state.quiz;
  if (!quiz) {
    renderNoteView();
    return;
  }
  $("#view").innerHTML = `
    <div class="quiz-head">
      <div>
        <h2>${esc(quiz.title)}</h2>
        <div class="meta">${quiz.questions.length} questions</div>
      </div>
      <button class="btn ghost" id="quitQuizBtn">Back to note</button>
    </div>
    <div class="progress-row">
      <div class="progress-bar"><i id="progressFill"></i></div>
      <span class="progress-label" id="progressLabel">0 of ${quiz.questions.length} answered</span>
    </div>
    <form id="quizForm">${quiz.questions.map(questionCard).join("")}</form>
    <div class="quiz-foot">
      <p class="hint">Unanswered questions are marked wrong.</p>
      <button class="btn primary" id="submitQuizBtn" type="button">Submit answers</button>
    </div>`;
  $("#quizForm").addEventListener("input", updateProgress);
  $("#quizForm").addEventListener("change", updateProgress);
  $("#quitQuizBtn").addEventListener("click", () => {
    if (quiz.note_id) {
      openNote(quiz.note_id);
    } else if (state.note) {
      renderNoteView();
    } else {
      renderEmpty();
    }
  });
  $("#submitQuizBtn").addEventListener("click", submitQuiz);
  restoreDraftAnswers();
  updateProgress();
}

async function submitQuiz() {
  const quiz = state.quiz;
  if (!quiz) return;
  const answers = quiz.questions.map((question, index) => {
    if (question.type === "short_answer") return ($(`#short-${index}`)?.value || "").trim();
    const checked = document.querySelector(`input[name="q${index}"]:checked`);
    if (!checked) return null;
    if (question.type === "true_false") return checked.value === "true";
    return Number(checked.value);
  });
  const missing = answers.filter((answer) => answer === null || answer === "").length;
  if (missing && !confirm(`${missing} question${missing === 1 ? "" : "s"} unanswered. Submit anyway?`)) {
    return;
  }
  const button = $("#submitQuizBtn");
  busy(button, "Grading");
  try {
    const payload = await api(`/api/quizzes/${quiz.id}/submit`, { method: "POST", body: { answers } });
    sessionStorage.removeItem(`sb_draft_${quiz.id}`);
    state.results = payload;
    renderResults(payload);
    $(".main").scrollTop = 0;
    await loadNotes();
    renderNotes();
  } catch (error) {
    toast(error.message, "error");
    idle(button, "Submit answers");
  }
}

function resultItem(result) {
  return `
    <div class="result-item ${result.correct ? "correct" : "incorrect"}">
      <div class="result-top">
        <span class="result-tag">${result.correct ? "Correct" : "Incorrect"}</span>
        ${typeBadge(result.type)}
      </div>
      <p class="result-q">${esc(result.question)}</p>
      <dl class="answer-row">
        <dt>Your answer</dt><dd>${esc(result.student_answer || "—")}</dd>
        <dt>Correct answer</dt><dd>${esc(result.correct_answer)}</dd>
      </dl>
      ${result.explanation ? `<div class="explain">${esc(result.explanation)}</div>` : ""}
      ${result.feedback ? `<div class="feedback">${esc(result.feedback)}</div>` : ""}
    </div>`;
}

function renderResults(payload) {
  const percent = payload.total ? Math.round((payload.score / payload.total) * 100) : 0;
  const verdict =
    percent >= 90
      ? "Excellent recall."
      : percent >= 75
        ? "Solid work."
        : percent >= 50
          ? "Getting there."
          : "Worth another review.";
  $("#view").innerHTML = `
    <div class="results-head">
      <div class="ring" style="--p:${percent}">
        <div class="ring-inner">
          <span class="pct">${percent}%</span>
          <span class="frac">${payload.score} / ${payload.total}</span>
        </div>
      </div>
      <div class="results-copy">
        <h2>${esc(payload.quiz_title)}</h2>
        <p>${verdict} You got ${payload.score} of ${payload.total} correct on “${esc(payload.note_title)}”.</p>
      </div>
    </div>
    ${payload.results.map(resultItem).join("")}
    <div class="quiz-foot">
      <button class="btn ghost" id="backToNoteBtn">Back to note</button>
      <div class="actions">
        <button class="btn ghost" id="retakeBtn">Retake</button>
        <button class="btn primary" id="newQuizBtn">New quiz</button>
      </div>
    </div>`;
  $("#backToNoteBtn").addEventListener("click", () => openNote(payload.note_id));
  $("#retakeBtn").addEventListener("click", () => retakeQuiz(payload.quiz_id));
  $("#newQuizBtn").addEventListener("click", async () => {
    if (!state.note || state.note.id !== payload.note_id) await openNote(payload.note_id);
    openGenerator();
  });
}

async function retakeQuiz(quizId) {
  try {
    const quiz = await api(`/api/quizzes/${quizId}`);
    startQuiz(quiz);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openNote(noteId) {
  try {
    const note = await api(`/api/notes/${noteId}`);
    state.note = note;
    state.quiz = null;
    state.results = null;
    renderNotes();
    renderNoteView();
    $(".main").scrollTop = 0;
  } catch (error) {
    toast(error.message, "error");
  }
}

function openNoteModal(note = null) {
  state.editingId = note ? note.id : null;
  $("#noteModalTitle").textContent = note ? "Edit note" : "New note";
  $("#noteTitle").value = note ? note.title : "";
  $("#noteContent").value = note ? note.content : "";
  openModal("noteModal");
  setTimeout(() => (note ? $("#noteContent") : $("#noteTitle")).focus(), 30);
}

async function saveNote() {
  const title = $("#noteTitle").value.trim();
  const content = $("#noteContent").value.trim();
  if (!content) {
    toast("Add some note content first.", "error");
    return;
  }
  const button = $("#saveNoteBtn");
  busy(button, "Saving");
  try {
    const payload = { title, content };
    const note = state.editingId
      ? await api(`/api/notes/${state.editingId}`, { method: "PUT", body: payload })
      : await api("/api/notes", { method: "POST", body: payload });
    closeModal("noteModal");
    await loadNotes();
    state.note = note;
    renderNotes();
    renderNoteView();
    toast(state.editingId ? "Note updated." : "Note saved.");
    $(".main").scrollTop = 0;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    idle(button, "Save note");
  }
}

async function deleteCurrentNote() {
  if (!state.note) return;
  if (!confirm(`Delete “${state.note.title}” and all of its quizzes?`)) return;
  try {
    await api(`/api/notes/${state.note.id}`, { method: "DELETE" });
    state.note = null;
    state.quiz = null;
    state.results = null;
    await loadNotes();
    renderNotes();
    renderEmpty();
    toast("Note deleted.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openGenerator() {
  if (!state.note) {
    toast("Open a note first.", "error");
    return;
  }
  openModal("genModal");
}

async function generateQuiz() {
  const types = [];
  if ($("#typeMc").checked) types.push("multiple_choice");
  if ($("#typeTf").checked) types.push("true_false");
  if ($("#typeSa").checked) types.push("short_answer");
  if (!types.length) {
    toast("Pick at least one question type.", "error");
    return;
  }
  const button = $("#genBtn");
  busy(button, "Writing questions");
  try {
    const quiz = await api(`/api/notes/${state.note.id}/generate`, {
      method: "POST",
      body: {
        count: Number($("#genCount").value),
        difficulty: $("#genDifficulty").value,
        types,
      },
    });
    closeModal("genModal");
    await loadNotes();
    renderNotes();
    startQuiz(quiz);
    toast("Quiz ready.");
  } catch (error) {
    toast(error.message, "error");
    if (/api key/i.test(error.message)) toast("Ask the administrator to configure the server API key.", "error");
  } finally {
    idle(button, "Generate quiz");
  }
}

async function showHistory() {
  try {
    const { attempts } = await api("/api/attempts");
    if (!attempts.length) {
      $("#view").innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path><path d="M12 7v5l3 2"></path>
            </svg>
          </div>
          <h2>No attempts yet</h2>
          <p>Generate a quiz from one of your notes and your scores will show up here.</p>
        </div>`;
      return;
    }
    $("#view").innerHTML = `
      <div class="view-head"><div><h2>History</h2><div class="meta">${attempts.length} recent attempt${attempts.length === 1 ? "" : "s"}</div></div></div>
      ${attempts
        .map((attempt) => {
          const percent = attempt.total ? Math.round((attempt.score / attempt.total) * 100) : 0;
          const cls = percent >= 75 ? "good" : percent < 50 ? "bad" : "";
          return `
            <button class="history-item" data-id="${attempt.id}">
              <div class="history-score ${cls}">${percent}%</div>
              <div class="history-main">
                <h3>${esc(attempt.quiz_title)}</h3>
                <p>${esc(attempt.note_title)} · ${attempt.score}/${attempt.total} correct</p>
              </div>
              <div class="history-date">${esc(formatDate(attempt.created_at))}</div>
            </button>`;
        })
        .join("")}`;
    $$(".history-item").forEach((button) => {
      button.addEventListener("click", () => openAttempt(Number(button.dataset.id)));
    });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openAttempt(attemptId) {
  try {
    const payload = await api(`/api/attempts/${attemptId}`);
    state.quiz = null;
    state.results = payload;
    renderResults(payload);
    $(".main").scrollTop = 0;
  } catch (error) {
    toast(error.message, "error");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsArrayBuffer(file);
  });
}

async function importFile(file) {
  if (!file) return;
  if (!/\.(txt|md|markdown|csv|json|log|docx|pdf)$/i.test(file.name)) {
    toast("Unsupported file type. Use .txt, .md, .docx, or .pdf.", "error");
    return;
  }
  try {
    const data = await fileToBase64(file);
    const result = await api("/api/extract", { method: "POST", body: { filename: file.name, data } });
    const textarea = $("#noteContent");
    textarea.value = textarea.value.trim() ? `${textarea.value.trimEnd()}\n\n${result.text}` : result.text;
    if (!$("#noteTitle").value.trim()) {
      $("#noteTitle").value = file.name.replace(/\.[^.]+$/, "");
    }
    toast(result.truncated ? "Imported (cut to 60k characters)." : `Imported ${file.name}.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function bind() {
  $("#newNoteBtn").addEventListener("click", () => openNoteModal());
  $("#saveNoteBtn").addEventListener("click", saveNote);
  $("#genBtn").addEventListener("click", generateQuiz);
  $("#historyBtn").addEventListener("click", showHistory);
  $("#logoutBtn").addEventListener("click", logoutUser);
  $("#authSubmitBtn").addEventListener("click", authSubmit);
  $("#authToggleBtn").addEventListener("click", toggleAuthModal);
  for (const field of ["#authUser", "#authPass", "#authCode"]) {
    $(field).addEventListener("keydown", (event) => {
      if (event.key === "Enter") authSubmit();
    });
  }
  $("#importBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    importFile(file);
  });
  $("#searchInput").addEventListener("input", (event) => {
    state.filter = event.target.value;
    renderNotes();
  });
  $("#noteContent").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveNote();
  });
  const dropZone = $("#dropZone");
  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) importFile(file);
  });
  $$("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });
  $$(".modal").forEach((modal) => {
    modal.addEventListener("mousedown", (event) => {
      if (event.target === modal) modal.classList.add("hidden");
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $$(".modal").forEach((modal) => modal.classList.add("hidden"));
    }
  });
}

async function refresh() {
  await Promise.all([loadMeta(), loadNotes()]);
  renderNotes();
  if (state.note) renderNoteView();
  else renderEmpty();
}

async function init() {
  bind();
  await refresh();
}

document.addEventListener("DOMContentLoaded", init);
