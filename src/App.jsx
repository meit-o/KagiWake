import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, ButtonGroup, Card, Form, InputGroup, Nav, Spinner } from "react-bootstrap";
import { firebaseConfigured, signInWithGoogle, signOutFromFirebase } from "./firebase";

const TOKEN_KEY = "rapan-token";

const viewItems = [
  { id: "calendar", label: "予定", icon: "calendar3" },
  { id: "reserve", label: "予約", icon: "plus-lg" },
  { id: "list", label: "一覧", icon: "list-check" },
  { id: "settings", label: "設定", icon: "gear" }
];

const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
const fullDayNames = ["日", "月", "火", "水", "木", "金", "土"];
const startHourOptions = Array.from({ length: 17 }, (_, index) => index + 6);
const endHourOptions = Array.from({ length: 17 }, (_, index) => index + 7);

function AppIcon({ name, size, className = "" }) {
  return <i className={`bi bi-${name} ${className}`.trim()} aria-hidden="true" style={size ? { fontSize: size } : undefined} />;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function hourLabel(hour) {
  return `${hour}:00`;
}

function hourValue(hour) {
  return `${pad(hour)}:00`;
}

function toDateInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayValue() {
  return toDateInputValue(new Date());
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthTitle(date) {
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "long" });
}

function dateLabel(value) {
  const date = parseDate(value);
  return `${date.getMonth() + 1}/${date.getDate()}(${fullDayNames[date.getDay()]})`;
}

function dateIndex(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function timeMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function reservationInterval(reservation) {
  const startDay = dateIndex(reservation.startDate);
  const endDay = dateIndex(reservation.endDate);

  if (reservation.allDay) {
    return {
      start: startDay * 1440,
      end: (endDay + 1) * 1440
    };
  }

  return {
    start: startDay * 1440 + timeMinutes(reservation.startTime),
    end: endDay * 1440 + timeMinutes(reservation.endTime)
  };
}

function overlaps(first, second) {
  const a = reservationInterval(first);
  const b = reservationInterval(second);
  return a.start < b.end && b.start < a.end;
}

function reservationsOnDate(reservations, value) {
  return reservations.filter((reservation) => reservation.startDate <= value && value <= reservation.endDate);
}

function createForm(date = todayValue()) {
  return {
    title: "",
    startDate: date,
    endDate: date,
    allDay: true,
    startTime: "09:00",
    endTime: "18:00",
    notes: ""
  };
}

function formatReservationRange(reservation) {
  const range =
    reservation.startDate === reservation.endDate
      ? dateLabel(reservation.startDate)
      : `${dateLabel(reservation.startDate)} - ${dateLabel(reservation.endDate)}`;

  if (reservation.allDay) {
    return `${range} 終日`;
  }

  return `${range} ${reservation.startTime}-${reservation.endTime}`;
}

function isValidCandidate(candidate) {
  if (!candidate.startDate || !candidate.endDate) return false;
  if (candidate.endDate < candidate.startDate) return false;

  if (!candidate.allDay) {
    if (!candidate.startTime || !candidate.endTime) return false;
    try {
      const interval = reservationInterval(candidate);
      return interval.end > interval.start;
    } catch {
      return false;
    }
  }

  return true;
}

function sortReservations(first, second) {
  return reservationInterval(first).start - reservationInterval(second).start;
}

function readJoinCodeFromLocation() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    return code ? code.trim().toUpperCase().slice(0, 12) : "";
  } catch {
    return "";
  }
}

async function apiRequest(token, path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 204) {
    if (!response.ok) throw new Error("エラーが発生しました。");
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error((data && data.message) || "エラーが発生しました。");
    error.status = response.status;
    error.conflicts = data && data.conflicts;
    throw error;
  }

  return data;
}

async function copyText(text) {
  if (!text) return false;

  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy fallback below
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function InviteShareCard({ group, busy, onGenerate, onShare, onCopy, copied }) {
  if (!group?.inviteCode) {
    return (
      <div className="invite-box">
        <span className="invite-label">招待コードはまだありません</span>
        <Button variant="primary" className="primary-button" type="button" onClick={onGenerate} disabled={busy}>
          <span>{busy ? "発行中" : "招待コードを発行する"}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="invite-box">
      <span className="invite-label">招待コード</span>
      <strong className="invite-code">{group.inviteCode}</strong>

      <InputGroup className="copy-field">
        <Form.Control type="text" aria-label="招待リンク" readOnly value={group.inviteLink || ""} onFocus={(event) => event.target.select()} />
        <Button variant="primary" type="button" onClick={onCopy} className={copied ? "is-copied" : ""}>
          <AppIcon name="clipboard" size={15} />
          <span>{copied ? "コピー済み" : "コピー"}</span>
        </Button>
      </InputGroup>

      <div className="share-actions">
        <Button variant="primary" className="primary-button" type="button" onClick={onShare}>
          <AppIcon name="share" size={18} />
          <span>共有する</span>
        </Button>
        <Button variant="outline-secondary" className="ghost-button" type="button" onClick={onGenerate} disabled={busy}>
          <span>{busy ? "発行中" : "コードを再発行する"}</span>
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => {
    try {
      return window.localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  });
  const [user, setUser] = useState(null);
  const [group, setGroup] = useState(null);
  const [bootLoading, setBootLoading] = useState(true);

  const [authMode, setAuthMode] = useState("signup");
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [onboardMode, setOnboardMode] = useState("choose");
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
  const [onboardError, setOnboardError] = useState("");
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [justCreated, setJustCreated] = useState(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(todayValue());
  const [activeView, setActiveView] = useState("calendar");
  const [form, setForm] = useState(createForm());
  const [editingId, setEditingId] = useState("");
  const [timeStage, setTimeStage] = useState("start");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const [groupNameSettingDraft, setGroupNameSettingDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  const reservations = group?.reservations || [];

  const memberById = useMemo(() => {
    return new Map((group?.members || []).map((member) => [member.userId, member]));
  }, [group]);

  const myMembership = user ? memberById.get(user.id) : null;

  const orderedReservations = useMemo(() => {
    return [...reservations].sort(sortReservations);
  }, [reservations]);

  const selectedReservations = useMemo(() => {
    return reservationsOnDate(orderedReservations, selectedDate);
  }, [orderedReservations, selectedDate]);

  const upcomingReservations = useMemo(() => {
    const today = todayValue();
    return orderedReservations.filter((reservation) => reservation.endDate >= today).slice(0, 8);
  }, [orderedReservations]);

  const calendarReservations = useMemo(() => {
    return orderedReservations.filter((reservation) => reservation.endDate >= todayValue()).slice(0, 12);
  }, [orderedReservations]);

  const candidate = useMemo(() => ({ ...form, id: editingId || "draft" }), [editingId, form]);
  const selectedStartHour = form.startTime ? Number(form.startTime.slice(0, 2)) : null;
  const selectedEndHour = form.endTime ? Number(form.endTime.slice(0, 2)) : null;

  const liveConflicts = useMemo(() => {
    if (!isValidCandidate(candidate)) return [];
    return reservations.filter((reservation) => reservation.id !== editingId && overlaps(candidate, reservation));
  }, [candidate, editingId, reservations]);

  const calendarDays = useMemo(() => {
    const firstDay = startOfMonth(currentMonth);
    const gridStart = addDays(firstDay, -firstDay.getDay());

    return Array.from({ length: 42 }, (_, index) => {
      const date = addDays(gridStart, index);
      const value = toDateInputValue(date);
      return {
        date,
        value,
        inMonth: date.getMonth() === currentMonth.getMonth(),
        reservations: reservationsOnDate(orderedReservations, value)
      };
    });
  }, [currentMonth, orderedReservations]);

  const currentUse = useMemo(() => {
    const now = todayValue();
    return orderedReservations.find((reservation) => reservation.startDate <= now && now <= reservation.endDate);
  }, [orderedReservations]);

  const nextUse = useMemo(() => {
    const now = todayValue();
    return orderedReservations.find((reservation) => reservation.startDate > now);
  }, [orderedReservations]);

  useEffect(() => {
    const codeFromUrl = readJoinCodeFromLocation();
    if (codeFromUrl) {
      setJoinCodeDraft(codeFromUrl);
      setOnboardMode("join");
    }

    async function boot() {
      if (!token) {
        setBootLoading(false);
        return;
      }

      try {
        const data = await apiRequest(token, "/api/me");
        setUser(data.user);
        setGroup(data.group);
        if (!data.group && codeFromUrl) setOnboardMode("join");
      } catch {
        try {
          window.localStorage.removeItem(TOKEN_KEY);
        } catch {
          /* ignore */
        }
        setToken("");
      } finally {
        setBootLoading(false);
      }
    }

    boot();
  }, []);

  useEffect(() => {
    if (group) {
      setGroupNameSettingDraft(group.name);
    }
    if (myMembership) {
      setDisplayNameDraft(myMembership.displayName);
    }
  }, [group, myMembership]);

  function updateForm(patch) {
    setNotice(null);
    setForm((current) => {
      const next = { ...current, ...patch };
      if (patch.startDate && (!current.endDate || current.endDate < patch.startDate)) {
        next.endDate = patch.startDate;
      }
      return next;
    });
  }

  function canManageReservation(reservation) {
    return !!user && reservation.userId === user.id;
  }

  function selectDay(value) {
    setSelectedDate(value);
    updateForm({ startDate: value, endDate: value });

    if (window.matchMedia("(max-width: 859px)").matches) {
      setActiveView("reserve");
    }
  }

  function resetForm(date = selectedDate) {
    setEditingId("");
    setTimeStage("start");
    setForm(createForm(date));
  }

  function setAllDayReservation() {
    setTimeStage("start");
    updateForm({ allDay: true, startTime: "", endTime: "" });
  }

  function startTimedReservation() {
    setTimeStage("start");
    updateForm({ allDay: false, startTime: "", endTime: "" });
  }

  function chooseStartHour(hour) {
    updateForm({ allDay: false, startTime: hourValue(hour), endTime: "" });
    setTimeStage("end");
  }

  function chooseEndHour(hour) {
    if (selectedStartHour === null || hour <= selectedStartHour) return;
    updateForm({ allDay: false, endTime: hourValue(hour) });
    setTimeStage("done");
  }

  function resetTimeSelection() {
    updateForm({ allDay: false, startTime: "", endTime: "" });
    setTimeStage("start");
  }

  // ---- auth ----

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");

    const username = authForm.username.trim();
    const password = authForm.password;

    if (username.length < 2) {
      setAuthError("ユーザー名は2文字以上で入力してください。");
      return;
    }

    if (password.length < 4) {
      setAuthError("パスワードは4文字以上で入力してください。");
      return;
    }

    setAuthBusy(true);
    try {
      const endpoint = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const data = await apiRequest("", endpoint, { method: "POST", body: { username, password } });

      try {
        window.localStorage.setItem(TOKEN_KEY, data.token);
      } catch {
        /* ignore */
      }

      setToken(data.token);
      setUser(data.user);
      setGroup(data.group);
      setAuthForm({ username: "", password: "" });

      if (!data.group) {
        setOnboardMode(joinCodeDraft ? "join" : "choose");
      }
    } catch (error) {
      setAuthError(error.message || "エラーが発生しました。");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitGoogleAuth() {
    setAuthError("");
    setAuthBusy(true);
    try {
      const google = await signInWithGoogle();
      const data = await apiRequest("", "/api/auth/firebase", {
        method: "POST",
        body: { idToken: google.idToken }
      });

      try {
        window.localStorage.setItem(TOKEN_KEY, data.token);
      } catch {
        /* ignore */
      }

      setToken(data.token);
      setUser(data.user);
      setGroup(data.group);
      setAuthForm({ username: "", password: "" });
      if (!data.group) setOnboardMode(joinCodeDraft ? "join" : "choose");
    } catch (error) {
      setAuthError(error.message || "Googleログインに失敗しました。");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      await apiRequest(token, "/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }

    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    await signOutFromFirebase().catch(() => {});

    setToken("");
    setUser(null);
    setGroup(null);
    setOnboardMode("choose");
    setJustCreated(null);
  }

  // ---- onboarding ----

  async function submitCreateGroup(event) {
    event.preventDefault();
    setOnboardError("");

    const name = groupNameDraft.trim();
    if (!name) {
      setOnboardError("車名や家族の名前を入力してください。");
      return;
    }

    setOnboardBusy(true);
    try {
      const created = await apiRequest(token, "/api/groups", { method: "POST", body: { name } });
      setGroup(created);
      setJustCreated(created);
    } catch (error) {
      setOnboardError(error.message || "作成できませんでした。");
    } finally {
      setOnboardBusy(false);
    }
  }

  async function submitJoinGroup(event) {
    event.preventDefault();
    setOnboardError("");

    const code = joinCodeDraft.trim().toUpperCase();
    if (code.length < 4) {
      setOnboardError("招待コードを入力してください。");
      return;
    }

    setOnboardBusy(true);
    try {
      const joined = await apiRequest(token, "/api/groups/join", { method: "POST", body: { code } });
      setGroup(joined);
    } catch (error) {
      setOnboardError(error.message || "参加できませんでした。");
    } finally {
      setOnboardBusy(false);
    }
  }

  // ---- invite sharing ----

  async function generateInviteCode() {
    setInviteBusy(true);
    setNotice(null);
    try {
      const updated = await apiRequest(token, "/api/group/invite-code", { method: "POST" });
      setGroup(updated);
      setJustCreated((current) => (current ? updated : current));
    } catch (error) {
      setNotice({ type: "error", message: error.message || "招待コードを発行できませんでした。" });
    } finally {
      setInviteBusy(false);
    }
  }

  async function shareInvite(inviteGroup) {
    if (!inviteGroup) return;
    const text = `${inviteGroup.name}の車予約カレンダーに参加してください。招待コード: ${inviteGroup.inviteCode}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "車予約カレンダーへの招待", text, url: inviteGroup.inviteLink });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }

    await copyInviteLink(inviteGroup);
  }

  async function copyInviteLink(inviteGroup) {
    if (!inviteGroup?.inviteLink) return;

    const ok = await copyText(inviteGroup.inviteLink);
    if (ok) {
      setNotice({ type: "success", message: "招待リンクをコピーしました。" });
      setCopiedInvite(true);
      window.setTimeout(() => setCopiedInvite(false), 1800);
    } else {
      setNotice({ type: "error", message: "コピーできませんでした。リンクの欄をタップして選択し、手動でコピーしてください。" });
    }
  }

  // ---- reservations ----

  async function submitReservation(event) {
    event.preventDefault();
    setNotice(null);

    if (!isValidCandidate(candidate)) {
      setNotice({ type: "error", message: "日付と時間を確認してください。" });
      return;
    }

    if (liveConflicts.length > 0) {
      setNotice({ type: "error", message: "重なっている予約があります。" });
      return;
    }

    setSaving(true);
    try {
      const saved = await apiRequest(token, editingId ? `/api/reservations/${editingId}` : "/api/reservations", {
        method: editingId ? "PUT" : "POST",
        body: form
      });

      setGroup((current) => {
        const nextReservations = editingId
          ? current.reservations.map((reservation) => (reservation.id === saved.id ? saved : reservation))
          : [...current.reservations, saved];
        return { ...current, reservations: nextReservations };
      });

      setSelectedDate(saved.startDate);
      resetForm(saved.startDate);
      setNotice({ type: "success", message: editingId ? "予約を更新しました。" : "予約しました。" });
      setActiveView("calendar");
    } catch (error) {
      setNotice({ type: "error", message: error.message || "予約できませんでした。" });
    } finally {
      setSaving(false);
    }
  }

  function editReservation(reservation) {
    if (!canManageReservation(reservation)) {
      setNotice({ type: "error", message: "ほかの人の予約は編集できません。" });
      return;
    }

    setEditingId(reservation.id);
    setForm({
      title: reservation.title || "",
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      allDay: reservation.allDay,
      startTime: reservation.startTime || "09:00",
      endTime: reservation.endTime || "18:00",
      notes: reservation.notes || ""
    });
    setTimeStage(reservation.allDay ? "start" : "done");
    setSelectedDate(reservation.startDate);
    setCurrentMonth(startOfMonth(parseDate(reservation.startDate)));
    setNotice(null);
    setActiveView("reserve");
  }

  async function deleteReservation(id) {
    const target = reservations.find((reservation) => reservation.id === id);
    if (!target) return;
    if (!canManageReservation(target)) {
      setNotice({ type: "error", message: "ほかの人の予約は取り消せません。" });
      return;
    }

    if (!window.confirm("この予約を取り消しますか？")) return;

    try {
      await apiRequest(token, `/api/reservations/${id}`, { method: "DELETE" });
      setGroup((current) => ({
        ...current,
        reservations: current.reservations.filter((reservation) => reservation.id !== id)
      }));
      if (editingId === id) resetForm();
      setNotice({ type: "success", message: "予約を取り消しました。" });
    } catch (error) {
      setNotice({ type: "error", message: error.message || "取り消しできませんでした。" });
    }
  }

  // ---- settings ----

  async function saveGroupName(event) {
    event.preventDefault();
    const name = groupNameSettingDraft.trim();
    if (!name) {
      setNotice({ type: "error", message: "名前を入力してください。" });
      return;
    }

    setProfileSaving(true);
    try {
      const updated = await apiRequest(token, "/api/group", { method: "PUT", body: { name } });
      setGroup(updated);
      setNotice({ type: "success", message: "保存しました。" });
    } catch (error) {
      setNotice({ type: "error", message: error.message || "保存できませんでした。" });
    } finally {
      setProfileSaving(false);
    }
  }

  async function saveDisplayName(event) {
    event.preventDefault();
    const displayName = displayNameDraft.trim();
    if (!displayName) {
      setNotice({ type: "error", message: "表示名を入力してください。" });
      return;
    }

    setProfileSaving(true);
    try {
      const updated = await apiRequest(token, "/api/profile", { method: "PUT", body: { displayName } });
      setGroup(updated);
      setNotice({ type: "success", message: "保存しました。" });
    } catch (error) {
      setNotice({ type: "error", message: error.message || "保存できませんでした。" });
    } finally {
      setProfileSaving(false);
    }
  }

  const canSubmit = isValidCandidate(candidate) && liveConflicts.length === 0 && !saving;

  // ---------------------------------------------------------------------
  // screens: boot / auth / onboarding / invite intro
  // ---------------------------------------------------------------------

  if (bootLoading) {
    return (
      <div className="loading-screen">
        <Spinner animation="border" role="status" aria-label="読み込み中" variant="primary" />
        <span>読み込み中…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-shell">
        <Card className="auth-card">
          <Card.Body>
          <div className="brand-mark" aria-hidden="true">
            <img src="/brand-logo.png" alt="" />
          </div>
          <h1>共有車予約</h1>
          <p className="auth-lead">家族や仲間と車のスケジュールを共有しましょう。</p>

          <Nav variant="pills" className="auth-tabs" aria-label="アカウント操作">
            <Nav.Item>
              <Nav.Link
                as="button"
                type="button"
                active={authMode === "signup"}
              onClick={() => {
                setAuthMode("signup");
                setAuthError("");
              }}
            >
              はじめる
              </Nav.Link>
            </Nav.Item>
            <Nav.Item>
              <Nav.Link
              as="button"
              type="button"
              active={authMode === "login"}
              onClick={() => {
                setAuthMode("login");
                setAuthError("");
              }}
            >
              ログイン
              </Nav.Link>
            </Nav.Item>
          </Nav>

          <Form className="auth-form" onSubmit={submitAuth}>
            <Form.Group className="field" controlId="auth-username">
              <Form.Label>ユーザーネーム</Form.Label>
              <InputGroup>
                <InputGroup.Text aria-hidden="true"><AppIcon name="person" /></InputGroup.Text>
                <Form.Control
                value={authForm.username}
                onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="例: taro"
                maxLength={24}
                autoComplete="username"
              />
              </InputGroup>
            </Form.Group>
            <Form.Group className="field" controlId="auth-password">
              <Form.Label>パスワード</Form.Label>
              <InputGroup>
                <InputGroup.Text aria-hidden="true"><AppIcon name="lock" /></InputGroup.Text>
                <Form.Control
                type="password"
                value={authForm.password}
                onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="4文字以上"
                maxLength={64}
                autoComplete={authMode === "signup" ? "new-password" : "current-password"}
              />
              </InputGroup>
            </Form.Group>

            {authError ? (
              <Alert variant="danger" className="notice error">
                <AppIcon name="exclamation-circle" size={18} />
                <span>{authError}</span>
              </Alert>
            ) : null}

            <Button variant="primary" className="primary-button w-100" type="submit" disabled={authBusy}>
              {authBusy ? <Spinner size="sm" animation="border" aria-hidden="true" /> : <AppIcon name={authMode === "signup" ? "person-plus" : "box-arrow-in-right"} />}
              <span>{authBusy ? "処理中" : authMode === "signup" ? "アカウントを作成" : "ログイン"}</span>
            </Button>
          </Form>

          {firebaseConfigured ? (
            <Button variant="outline-secondary" className="ghost-button google-button" type="button" onClick={submitGoogleAuth} disabled={authBusy}>
              {authBusy ? <Spinner size="sm" animation="border" aria-hidden="true" /> : <AppIcon name="google" className="google-mark" />}
              <span>Googleでログイン</span>
            </Button>
          ) : null}
          </Card.Body>
        </Card>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="auth-shell">
        <Card className="auth-card">
          <Card.Body>
          <div className="brand-mark" aria-hidden="true">
            <img src="/brand-logo.png" alt="" />
          </div>
          <h1>グループを設定</h1>
          <p className="auth-lead">{user.username}さん、車を共有するグループを作るか、招待されたグループに参加してください。</p>

          {onboardMode === "choose" ? (
            <div className="onboard-choices">
              <Button variant="light" className="onboard-choice" type="button" onClick={() => setOnboardMode("create")}>
                <AppIcon name="plus-circle" size={20} />
                <span className="onboard-choice-copy"><strong>グループを作る</strong><span>新しく車の予約グループを作成します</span></span>
                <AppIcon name="chevron-right" />
              </Button>
              <Button variant="light" className="onboard-choice" type="button" onClick={() => setOnboardMode("join")}>
                <AppIcon name="people" size={20} />
                <span className="onboard-choice-copy"><strong>グループに入る</strong><span>招待コードやリンクで参加します</span></span>
                <AppIcon name="chevron-right" />
              </Button>
            </div>
          ) : null}

          {onboardMode === "create" ? (
            <Form className="auth-form" onSubmit={submitCreateGroup}>
              <Form.Group className="field" controlId="onboard-group-name">
                <Form.Label>車名・家族の名前</Form.Label>
                <Form.Control
                  value={groupNameDraft}
                  onChange={(event) => setGroupNameDraft(event.target.value)}
                  placeholder="例: プリウス"
                  maxLength={28}
                  autoFocus
                />
              </Form.Group>

              {onboardError ? (
                <Alert variant="danger" className="notice error">
                  <AppIcon name="exclamation-circle" size={18} />
                  <span>{onboardError}</span>
                </Alert>
              ) : null}

              <Button variant="primary" className="primary-button w-100" type="submit" disabled={onboardBusy}>
                {onboardBusy ? <Spinner size="sm" animation="border" aria-hidden="true" /> : <AppIcon name="plus-lg" />}
                <span>{onboardBusy ? "作成中" : "グループを作成"}</span>
              </Button>
              <Button variant="outline-secondary" className="ghost-button w-100" type="button" onClick={() => setOnboardMode("choose")}>
                <AppIcon name="arrow-left" />
                <span>戻る</span>
              </Button>
            </Form>
          ) : null}

          {onboardMode === "join" ? (
            <Form className="auth-form" onSubmit={submitJoinGroup}>
              <Form.Group className="field" controlId="onboard-invite-code">
                <Form.Label>招待コード</Form.Label>
                <Form.Control
                  value={joinCodeDraft}
                  onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
                  placeholder="例: AB12CD"
                  maxLength={12}
                  autoFocus
                />
              </Form.Group>

              {onboardError ? (
                <Alert variant="danger" className="notice error">
                  <AppIcon name="exclamation-circle" size={18} />
                  <span>{onboardError}</span>
                </Alert>
              ) : null}

              <Button variant="primary" className="primary-button w-100" type="submit" disabled={onboardBusy}>
                {onboardBusy ? <Spinner size="sm" animation="border" aria-hidden="true" /> : <AppIcon name="box-arrow-in-right" />}
                <span>{onboardBusy ? "参加中" : "グループに参加"}</span>
              </Button>
              <Button variant="outline-secondary" className="ghost-button w-100" type="button" onClick={() => setOnboardMode("choose")}>
                <AppIcon name="arrow-left" />
                <span>戻る</span>
              </Button>
            </Form>
          ) : null}

          <Button variant="outline-secondary" className="ghost-button auth-logout" type="button" onClick={logout}>
            <AppIcon name="box-arrow-right" size={16} />
            <span>ログアウト</span>
          </Button>
          </Card.Body>
        </Card>
      </div>
    );
  }

  if (justCreated) {
    return (
      <div className="auth-shell">
        <Card className="auth-card">
          <Card.Body>
          <div className="brand-mark" aria-hidden="true">
            <img src="/brand-logo.png" alt="" />
          </div>
          <h1>グループを作成しました</h1>
          <p className="auth-lead">このコードやリンクを家族に共有すると、みんなで予約カレンダーを使えます。</p>

          <InviteShareCard
            group={justCreated}
            busy={inviteBusy}
            copied={copiedInvite}
            onGenerate={generateInviteCode}
            onShare={() => shareInvite(justCreated)}
            onCopy={() => copyInviteLink(justCreated)}
          />

          {notice ? (
            <Alert variant={notice.type === "success" ? "success" : "danger"} className={`notice ${notice.type}`} role="status">
              {notice.type === "success" ? <AppIcon name="check-lg" size={18} /> : <AppIcon name="exclamation-circle" size={18} />}
              <span>{notice.message}</span>
            </Alert>
          ) : null}

          <Button
            variant="primary"
            className="primary-button w-100"
            type="button"
            onClick={() => {
              setJustCreated(null);
              setNotice(null);
            }}
          >
            <AppIcon name="arrow-right" />
            <span>アプリを使いはじめる</span>
          </Button>
          </Card.Body>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // main app
  // ---------------------------------------------------------------------

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-area">
          <div className="brand-mark" aria-hidden="true">
            <img src="/brand-logo.png" alt="" />
          </div>
          <div>
            <p className="eyebrow">共有車カレンダー</p>
            <h1>{group.name}予約</h1>
          </div>
        </div>

        <div className="vehicle-strip">
          <div className="vehicle-icon" aria-hidden="true">
            <AppIcon name="car-front-fill" size={26} />
          </div>
          <div className="vehicle-copy">
            <Badge bg="primary" className="status-label">{currentUse ? "使用中" : "空き"}</Badge>
            <strong>{currentUse ? memberById.get(currentUse.userId)?.displayName || "予約あり" : "今日は空いています"}</strong>
            <span>{nextUse ? `次回 ${dateLabel(nextUse.startDate)}` : "次の予約はありません"}</span>
          </div>
        </div>
      </header>

      <Nav
        as="nav"
        variant="pills"
        className="view-nav"
        activeKey={activeView}
        onSelect={(key) => key && setActiveView(key)}
        aria-label="画面切り替え"
      >
        {viewItems.map((item) => {
          return (
            <Nav.Item key={item.id}>
              <Nav.Link as="button" type="button" eventKey={item.id} aria-label={item.label}>
              <AppIcon name={item.icon} size={18} />
              <span>{item.label}</span>
              </Nav.Link>
            </Nav.Item>
          );
        })}
      </Nav>

      <section className="current-user-panel" aria-label="ログイン中のユーザー">
        <span>ログイン中</span>
        <div className="current-user-buttons">
          <span className="is-active" style={{ "--member-color": myMembership?.color || "#2563eb" }}>
            <AppIcon name="person-circle" size={16} />
            <span>{myMembership?.displayName || user.username}</span>
          </span>
          <Button variant="outline-secondary" type="button" className="logout-inline" onClick={logout}>
            <AppIcon name="box-arrow-right" size={16} />
            <span>ログアウト</span>
          </Button>
        </div>
      </section>

      {notice ? (
        <Alert variant={notice.type === "success" ? "success" : "danger"} className={`notice ${notice.type}`} role="status">
          {notice.type === "success" ? <AppIcon name="check-lg" size={18} /> : <AppIcon name="exclamation-circle" size={18} />}
          <span>{notice.message}</span>
        </Alert>
      ) : null}

      <main className="app-main" aria-busy={bootLoading}>
        <Card as="section" className={`panel calendar-panel view-panel ${activeView === "calendar" ? "is-active" : ""}`}>
          <Card.Header className="panel-heading">
            <div>
              <p className="eyebrow">今月の予定</p>
              <h2>{monthTitle(currentMonth)}</h2>
            </div>
            <div className="icon-group">
              <Button
                variant="light"
                className="icon-button"
                type="button"
                onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
                aria-label="前の月"
                title="前の月"
              >
                <AppIcon name="chevron-left" size={20} />
              </Button>
              <Button
                variant="light"
                className="icon-button"
                type="button"
                onClick={() => setCurrentMonth(startOfMonth(new Date()))}
                aria-label="今月"
                title="今月"
              >
                <AppIcon name="calendar3" size={20} />
              </Button>
              <Button
                variant="light"
                className="icon-button"
                type="button"
                onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                aria-label="次の月"
                title="次の月"
              >
                <AppIcon name="chevron-right" size={20} />
              </Button>
            </div>
          </Card.Header>

          <div className="week-row">
            {dayNames.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="calendar-grid">
            {calendarDays.map((day) => {
              const isToday = day.value === todayValue();
              const isSelected = day.value === selectedDate;
              const isSunday = day.date.getDay() === 0;
              const isSaturday = day.date.getDay() === 6;

              return (
                <button
                  key={day.value}
                  type="button"
                  className={[
                    "day-cell",
                    day.inMonth ? "" : "is-outside",
                    isToday ? "is-today" : "",
                    isSelected ? "is-selected" : "",
                    day.reservations.length > 0 ? "has-booking" : "",
                    isSunday ? "is-sunday" : "",
                    isSaturday ? "is-saturday" : ""
                  ].join(" ")}
                  onClick={() => selectDay(day.value)}
                >
                  <span className="day-number">{day.date.getDate()}</span>
                  <span className="day-bookings">
                    {day.reservations.slice(0, 2).map((reservation) => {
                      const member = memberById.get(reservation.userId);
                      return (
                        <span
                          key={reservation.id}
                          className="booking-dot"
                          style={{ "--member-color": member?.color || "#475569" }}
                        >
                          {member?.displayName || "予約"}
                        </span>
                      );
                    })}
                    {day.reservations.length > 2 ? <span className="more-dot">+{day.reservations.length - 2}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="selected-strip">
            <div>
              <p className="eyebrow">選択日</p>
              <strong>{dateLabel(selectedDate)}</strong>
            </div>
            <div className="selected-actions">
              <div className="selected-list">
                {selectedReservations.length === 0 ? (
                  <span className="empty-inline">この日は空いています</span>
                ) : (
                  selectedReservations.map((reservation) => {
                    const canManage = canManageReservation(reservation);

                    return (
                      <Button
                        variant="light"
                        key={reservation.id}
                        className={`mini-booking ${canManage ? "" : "is-locked"}`}
                        type="button"
                        onClick={() => (canManage ? editReservation(reservation) : null)}
                        disabled={!canManage}
                      >
                        <span
                          className="mini-color"
                          style={{ "--member-color": memberById.get(reservation.userId)?.color || "#475569" }}
                        />
                        <span>{memberById.get(reservation.userId)?.displayName || "予約"}</span>
                        {!canManage ? <AppIcon name="lock-fill" size={14} /> : null}
                      </Button>
                    );
                  })
                )}
              </div>
              <Button variant="primary" className="quick-reserve-button" type="button" onClick={() => setActiveView("reserve")}>
                <AppIcon name="plus-lg" size={16} />
                <span>この日に予約</span>
              </Button>
            </div>
          </div>

          <div className="calendar-reservation-board">
            <div className="board-heading">
              <div>
                <p className="eyebrow">登録済み</p>
                <h3>これからの予定</h3>
              </div>
              <span>{calendarReservations.length}件</span>
            </div>

            {calendarReservations.length === 0 ? (
              <div className="empty-state compact">
                <AppIcon name="calendar3" size={22} />
                <strong>登録済みの予定はありません</strong>
              </div>
            ) : (
              <div className="calendar-reservation-list">
                {calendarReservations.map((reservation) => {
                  const member = memberById.get(reservation.userId);
                  const canManage = canManageReservation(reservation);

                  return (
                    <article
                      key={reservation.id}
                      className="calendar-reservation-row"
                      style={{ "--member-color": member?.color || "#475569" }}
                    >
                      <div className="booking-main">
                        <span className="member-pill">
                          <span className="pill-dot" />
                          {member?.displayName || "予約"}
                        </span>
                        <h3>{reservation.title || "車を使う"}</h3>
                        <p>
                          <AppIcon name="clock" size={15} />
                          {formatReservationRange(reservation)}
                        </p>
                        {reservation.notes ? <p className="note-text">{reservation.notes}</p> : null}
                      </div>
                      {canManage ? (
                        <div className="card-actions">
                          <Button variant="light" className="icon-button" type="button" onClick={() => editReservation(reservation)} aria-label="編集" title="編集">
                            <AppIcon name="pencil" size={18} />
                          </Button>
                          <Button
                            variant="outline-danger"
                            className="icon-button danger"
                            type="button"
                            onClick={() => deleteReservation(reservation.id)}
                            aria-label="削除"
                            title="削除"
                          >
                            <AppIcon name="trash3" size={18} />
                          </Button>
                        </div>
                      ) : (
                        <div className="locked-owner" title="ほかの人の予約です">
                          <AppIcon name="lock-fill" size={17} />
                          <span>ほかの人</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <Card as="section" className={`panel form-panel view-panel ${activeView === "reserve" ? "is-active" : ""}`}>
          <Card.Header className="panel-heading">
            <div>
              <p className="eyebrow">予約入力</p>
              <h2>{editingId ? "予約編集" : "新しい予約"}</h2>
            </div>
            {editingId ? (
              <Button variant="light" className="icon-button" type="button" onClick={() => resetForm()} aria-label="編集をやめる" title="編集をやめる">
                <AppIcon name="x-lg" size={20} />
              </Button>
            ) : null}
          </Card.Header>

          <Form className="reservation-form" onSubmit={submitReservation}>
            <div className="reserving-as">
              <span
                className="mini-color"
                style={{ "--member-color": myMembership?.color || "#2563eb" }}
              />
              <span>{myMembership?.displayName || user.username}として予約します</span>
            </div>

            <Form.Group className="field" controlId="reservation-title">
              <Form.Label>予定名</Form.Label>
              <Form.Control
                value={form.title}
                onChange={(event) => updateForm({ title: event.target.value })}
                placeholder="帰省、買い物、送迎など"
                maxLength={40}
              />
            </Form.Group>

            <div className="date-grid">
              <Form.Group className="field" controlId="reservation-start-date">
                <Form.Label>開始</Form.Label>
                <Form.Control type="date" value={form.startDate} onChange={(event) => updateForm({ startDate: event.target.value })} />
              </Form.Group>
              <Form.Group className="field" controlId="reservation-end-date">
                <Form.Label>終了</Form.Label>
                <Form.Control type="date" value={form.endDate} onChange={(event) => updateForm({ endDate: event.target.value })} />
              </Form.Group>
            </div>

            <div className="time-section">
              <span className="field-label">時間</span>
              <ButtonGroup className="time-mode" role="group" aria-label="予約時間">
                <Button variant={form.allDay ? "primary" : "outline-secondary"} type="button" onClick={setAllDayReservation} aria-pressed={form.allDay}>
                  終日
                </Button>
                <Button variant={!form.allDay ? "primary" : "outline-secondary"} type="button" onClick={startTimedReservation} aria-pressed={!form.allDay}>
                  時間指定
                </Button>
              </ButtonGroup>

              {!form.allDay ? (
                <div className="time-picker">
                  {timeStage === "done" && form.startTime && form.endTime ? (
                    <div className="time-summary">
                      <strong>
                        {form.startTime} - {form.endTime}
                      </strong>
                      <Button variant="outline-secondary" type="button" onClick={resetTimeSelection}>
                        選び直す
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="time-hint">
                        {timeStage === "end" && selectedStartHour !== null
                          ? `${hourLabel(selectedStartHour)}から使います。返す時間を選んでください。`
                          : "使い始める時間を選んでください。"}
                      </p>
                      <div className="hour-list">
                        {(timeStage === "end" ? endHourOptions : startHourOptions).map((hour) => {
                          const isDisabled = timeStage === "end" && selectedStartHour !== null && hour <= selectedStartHour;
                          const isPickedStart = selectedStartHour === hour;
                          const isPickedEnd = selectedEndHour === hour;

                          return (
                            <Button
                              key={hour}
                              variant={isPickedStart || isPickedEnd ? "primary" : "outline-secondary"}
                              type="button"
                              className={isPickedStart || isPickedEnd ? "is-picked" : ""}
                              disabled={isDisabled}
                              onClick={() => (timeStage === "end" ? chooseEndHour(hour) : chooseStartHour(hour))}
                            >
                              {timeStage === "end" ? hourLabel(hour) : `${hourLabel(hour)}〜`}
                            </Button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>

            <Form.Group className="field" controlId="reservation-notes">
              <Form.Label>メモ</Form.Label>
              <Form.Control
                as="textarea"
                value={form.notes}
                onChange={(event) => updateForm({ notes: event.target.value })}
                placeholder="鍵、駐車場所、帰宅時間など"
                maxLength={160}
              />
            </Form.Group>

            {liveConflicts.length > 0 ? (
              <div className="conflict-box">
                <AppIcon name="exclamation-circle" size={18} />
                <div>
                  <strong>重複あり</strong>
                  <span>{liveConflicts.map((reservation) => memberById.get(reservation.userId)?.displayName || "予約").join("、")}</span>
                </div>
              </div>
            ) : null}

            <div className="form-actions">
              <Button variant="primary" className="primary-button" type="submit" disabled={!canSubmit}>
                {saving ? <Spinner size="sm" animation="border" aria-hidden="true" /> : null}
                <AppIcon name="floppy" size={18} />
                <span>{saving ? "保存中" : editingId ? "更新" : "予約"}</span>
              </Button>
              <Button variant="outline-secondary" className="ghost-button" type="button" onClick={() => resetForm()}>
                <AppIcon name="x-lg" size={18} />
                <span>リセット</span>
              </Button>
            </div>
          </Form>
        </Card>

        <Card as="section" className={`panel list-panel view-panel ${activeView === "list" ? "is-active" : ""}`}>
          <Card.Header className="panel-heading">
            <div>
              <p className="eyebrow">次の予約</p>
              <h2>これからの予約</h2>
            </div>
            <Button variant="primary" className="icon-button accent" type="button" onClick={() => setActiveView("reserve")} aria-label="予約を追加" title="予約を追加">
              <AppIcon name="plus-lg" size={20} />
            </Button>
          </Card.Header>

          <div className="booking-list">
            {upcomingReservations.length === 0 ? (
              <div className="empty-state">
                <AppIcon name="calendar3" size={24} />
                <strong>予約はまだありません</strong>
              </div>
            ) : (
              upcomingReservations.map((reservation) => {
                const member = memberById.get(reservation.userId);
                const canManage = canManageReservation(reservation);

                return (
                  <article
                    key={reservation.id}
                    className="booking-card"
                    style={{ "--member-color": member?.color || "#475569" }}
                  >
                    <div className="booking-main">
                      <span className="member-pill">
                        <span className="pill-dot" />
                        {member?.displayName || "予約"}
                      </span>
                      <h3>{reservation.title || "車を使う"}</h3>
                      <p>
                        <AppIcon name="clock" size={15} />
                        {formatReservationRange(reservation)}
                      </p>
                      {reservation.notes ? <p className="note-text">{reservation.notes}</p> : null}
                    </div>
                    {canManage ? (
                      <div className="card-actions">
                        <Button variant="light" className="icon-button" type="button" onClick={() => editReservation(reservation)} aria-label="編集" title="編集">
                          <AppIcon name="pencil" size={18} />
                        </Button>
                        <Button
                          variant="outline-danger"
                          className="icon-button danger"
                          type="button"
                          onClick={() => deleteReservation(reservation.id)}
                          aria-label="削除"
                          title="削除"
                        >
                          <AppIcon name="trash3" size={18} />
                        </Button>
                      </div>
                    ) : (
                      <div className="locked-owner" title="ほかの人の予約です">
                        <AppIcon name="lock-fill" size={17} />
                        <span>ほかの人</span>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </Card>

        <Card as="section" className={`panel settings-panel view-panel ${activeView === "settings" ? "is-active" : ""}`}>
          <Card.Header className="panel-heading">
            <div>
              <p className="eyebrow">設定</p>
              <h2>グループとプロフィール</h2>
            </div>
          </Card.Header>

          <div className="settings-form">
            <Form onSubmit={saveGroupName} className="settings-block">
              <Form.Group className="field" controlId="settings-group-name">
                <Form.Label>車名・グループ名</Form.Label>
                <Form.Control
                  value={groupNameSettingDraft}
                  onChange={(event) => setGroupNameSettingDraft(event.target.value)}
                  maxLength={28}
                />
              </Form.Group>
              <Button variant="outline-secondary" className="ghost-button" type="submit" disabled={profileSaving}>
                {profileSaving ? <Spinner size="sm" animation="border" aria-hidden="true" /> : null}
                <AppIcon name="floppy" size={18} />
                <span>保存</span>
              </Button>
            </Form>

            <Form onSubmit={saveDisplayName} className="settings-block">
              <Form.Group className="field" controlId="settings-display-name">
                <Form.Label>自分の表示名</Form.Label>
                <Form.Control
                  value={displayNameDraft}
                  onChange={(event) => setDisplayNameDraft(event.target.value)}
                  maxLength={20}
                />
              </Form.Group>
              <Button variant="outline-secondary" className="ghost-button" type="submit" disabled={profileSaving}>
                {profileSaving ? <Spinner size="sm" animation="border" aria-hidden="true" /> : null}
                <AppIcon name="floppy" size={18} />
                <span>保存</span>
              </Button>
            </Form>

            <div className="settings-block">
              <span className="field-label">メンバー</span>
              <div className="member-list">
                {(group.members || []).map((member) => (
                  <span key={member.userId} className="member-pill" style={{ "--member-color": member.color }}>
                    <span className="pill-dot" />
                    {member.displayName}
                  </span>
                ))}
              </div>
            </div>

            <div className="settings-block">
              <InviteShareCard
                group={group}
                busy={inviteBusy}
                copied={copiedInvite}
                onGenerate={generateInviteCode}
                onShare={() => shareInvite(group)}
                onCopy={() => copyInviteLink(group)}
              />
            </div>

            <Button variant="outline-danger" className="ghost-button danger-outline" type="button" onClick={logout}>
              <AppIcon name="box-arrow-right" size={18} />
              <span>ログアウト</span>
            </Button>
          </div>
        </Card>
      </main>
    </div>
  );
}
