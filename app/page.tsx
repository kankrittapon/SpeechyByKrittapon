"use client";

import { createClient, type User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const CHUNK_DELAY_MS = 20;
const READER_CHUNK_MAX = 540;
const SPEECH_WATCHDOG_EXTRA_MS = 7000;
const SPEECH_WATCHDOG_MIN_MS = 12000;
const SPEECH_WATCHDOG_MAX_MS = 45000;
const SPEECH_KEEP_ALIVE_MS = 9000;
const RESUME_STORAGE_KEY = "audioReaderResumeSessions";
const RESUME_STORAGE_LIMIT = 12;
const VISIBLE_BEFORE = 80;
const VISIBLE_AFTER = 180;
const VISIBLE_EXPAND_STEP = 120;
const LARGE_FILE_WINDOW_THRESHOLD = 2000;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const ALLOWED_EMAILS = (process.env.NEXT_PUBLIC_ALLOWED_EMAILS ?? process.env.NEXT_PUBLIC_ALLOWED_EMAIL ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const SAMPLE_TEXT = `บทที่ 1 เสียงจากทะเลทราย

ลมร้อนพัดผ่านซากหินสีดำ ขณะที่นักผจญภัยหยุดยืนหน้าประตูโบราณ แสงสีทองค่อย ๆ ไหลไปตามรอยสลักราวกับมันกำลังตื่นจากการหลับใหลยาวนาน

ตอนที่ 2 คำสัญญาของนักเดินทาง

ไม่มีใครรู้ว่าปลายทางอยู่ที่ใด แต่ทุกคนรู้ว่าการเดินทางครั้งนี้จะเปลี่ยนพวกเขาไปตลอดกาล`;

interface Chunk {
  text: string;
  start: number;
  end: number;
  readableIndex: number | null;
}

interface ReadableChunk {
  text: string;
  displayIndex: number;
}

interface TocItem {
  title: string;
  chunkIndex: number;
}

interface CleanStats {
  removedRuleLines: number;
  splitLongParagraphs: number;
  collapsedBlankRuns: number;
}

interface ProcessedText {
  text: string;
  displayChunks: Chunk[];
  readableChunks: ReadableChunk[];
  toc: TocItem[];
  stats: CleanStats;
}

interface ResumeSession {
  fileHash: string;
  fileName: string;
  textLength: number;
  readableCount: number;
  currentReadableIndex: number;
  currentDisplayIndex: number;
  rate: number;
  voiceURI: string;
  updatedAt: string;
}

interface PendingResume {
  session: ResumeSession;
  displayIndex: number;
  readableIndex: number;
}

interface VisibleWindow {
  start: number;
  end: number;
  before: number;
  after: number;
}

const clampVisibleWindow = (centerIndex: number, total: number, before: number, after: number): VisibleWindow => {
  if (total <= 0) return { start: 0, end: 0, before, after };

  const safeCenter = Math.max(0, Math.min(total - 1, centerIndex));
  return {
    start: Math.max(0, safeCenter - before),
    end: Math.min(total, safeCenter + after + 1),
    before,
    after,
  };
};

const blankStats = (): CleanStats => ({
  removedRuleLines: 0,
  splitLongParagraphs: 0,
  collapsedBlankRuns: 0,
});

const normalizeTextLine = (value: string) =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

const isChapterTitle = (value: string) => /^\s*(บทพิเศษ|บทที่|ตอนที่|chapter)\s*[\wก-๙ .:-]+/i.test(value);

const splitLongParagraph = (paragraph: string, stats: CleanStats) => {
  const clean = normalizeTextLine(paragraph);
  if (clean.length <= READER_CHUNK_MAX) return [clean];

  stats.splitLongParagraphs += 1;
  const chunks: string[] = [];
  let remaining = clean;
  const breakChars = ["”", "?", "!", "ฯ", "。", ".", ",", "，", " "];

  while (remaining.length > READER_CHUNK_MAX) {
    let cut = -1;
    for (const character of breakChars) {
      const index = remaining.lastIndexOf(character, READER_CHUNK_MAX);
      if (index > Math.floor(READER_CHUNK_MAX * 0.55)) {
        cut = index + (character === " " ? 0 : 1);
        break;
      }
    }
    if (cut <= 0) cut = READER_CHUNK_MAX;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
};

const normalizeUploadedText = (rawText: string, stats: CleanStats) => {
  const normalized = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ");

  const lines = normalized.split("\n");
  const keptLines = lines.filter((line) => {
    const trimmed = line.trim();
    const isRuleLine = /^═{8,}$/.test(trimmed) || /^[-–—_]{8,}$/.test(trimmed);
    if (isRuleLine) stats.removedRuleLines += 1;
    return !isRuleLine;
  });

  const withoutTrailingSpaces = keptLines.join("\n").replace(/[ \t]+\n/g, "\n");
  const collapsed = withoutTrailingSpaces.replace(/\n{3,}/g, () => {
    stats.collapsedBlankRuns += 1;
    return "\n\n";
  });

  return collapsed.trim();
};

const hashText = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const readResumeSessions = (): ResumeSession[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeResumeSessions = (sessions: ResumeSession[]) => {
  localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(sessions.slice(0, RESUME_STORAGE_LIMIT)));
};

const findResumeSession = (fileHash: string) =>
  readResumeSessions().find((session) => session.fileHash === fileHash) ?? null;

const saveResumeSession = (session: ResumeSession) => {
  const otherSessions = readResumeSessions().filter((item) => item.fileHash !== session.fileHash);
  writeResumeSessions([session, ...otherSessions]);
};

const buildProcessedText = (rawText: string): ProcessedText => {
  const stats = blankStats();
  const text = normalizeUploadedText(rawText, stats);
  const displayChunks: Chunk[] = [];
  const readableChunks: ReadableChunk[] = [];
  const toc: TocItem[] = [];

  const pushReadableChunk = (chunkText: string) => {
    const displayIndex = displayChunks.length;
    const readableIndex = readableChunks.length;
    displayChunks.push({
      text: chunkText,
      start: displayIndex,
      end: displayIndex + chunkText.length,
      readableIndex,
    });
    readableChunks.push({ text: chunkText, displayIndex });

    if (isChapterTitle(chunkText)) {
      toc.push({ title: chunkText.slice(0, 80), chunkIndex: displayIndex });
    }
  };

  text
    .split(/\n{2,}/)
    .map(normalizeTextLine)
    .filter(Boolean)
    .forEach((paragraph, paragraphIndex) => {
      if (paragraphIndex > 0) {
        const displayIndex = displayChunks.length;
        displayChunks.push({ text: "\n", start: displayIndex, end: displayIndex + 1, readableIndex: null });
      }

      splitLongParagraph(paragraph, stats).forEach(pushReadableChunk);
    });

  return { text, displayChunks, readableChunks, toc, stats };
};

export default function AudioReader() {
  const supabase = useMemo(() => {
    if (!SUPABASE_CONFIGURED) return null;
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }, []);
  const authConfigured = Boolean(supabase);
  const [authLoading, setAuthLoading] = useState(SUPABASE_CONFIGURED);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [text, setText] = useState("");
  const [displayChunks, setDisplayChunks] = useState<Chunk[]>([]);
  const [readableChunks, setReadableChunks] = useState<ReadableChunk[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentReadableIndex, setCurrentReadableIndex] = useState(0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [notice, setNotice] = useState("พร้อมรับไฟล์ .txt หรือวางข้อความเพื่อเริ่มอ่าน");
  const [fileName, setFileName] = useState("");
  const [fileHash, setFileHash] = useState("");
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
  const [visibleWindow, setVisibleWindow] = useState<VisibleWindow>(() =>
    clampVisibleWindow(0, 0, VISIBLE_BEFORE, VISIBLE_AFTER),
  );

  const readerRef = useRef<HTMLDivElement>(null);
  const speakChunkRef = useRef<(readableIndex: number) => void>(() => {});
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const isPausedRef = useRef(false);
  const currentReadableIndexRef = useRef(0);
  const pendingScrollIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setAuthUser(data.session?.user ?? null);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) {
        setNotice("เบราว์เซอร์นี้ยังไม่รองรับระบบอ่านออกเสียง");
        return;
      }

      const availableVoices = window.speechSynthesis.getVoices();
      availableVoices.sort((a, b) => {
        if (a.lang.includes("th") && !b.lang.includes("th")) return -1;
        if (!a.lang.includes("th") && b.lang.includes("th")) return 1;
        return a.name.localeCompare(b.name);
      });

      setVoices(availableVoices);

      const savedVoice = localStorage.getItem("savedVoice");
      const savedRate = localStorage.getItem("savedRate");
      const fallbackVoice =
        availableVoices.find((voice) => voice.lang.includes("th") && voice.default) ??
        availableVoices.find((voice) => voice.lang.includes("th")) ??
        availableVoices[0];

      if (savedVoice && availableVoices.some((voice) => voice.voiceURI === savedVoice)) {
        setSelectedVoice(savedVoice);
      } else if (fallbackVoice) {
        setSelectedVoice(fallbackVoice.voiceURI);
      }

      if (savedRate) setRate(parseFloat(savedRate));
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    if (selectedVoice) localStorage.setItem("savedVoice", selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem("savedRate", rate.toString());
  }, [rate]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    currentReadableIndexRef.current = currentReadableIndex;
  }, [currentReadableIndex]);

  useEffect(() => {
    if (!fileHash || !readableChunks.length) return;
    saveResumeSession({
      fileHash,
      fileName: fileName || "ข้อความที่วาง",
      textLength: text.length,
      readableCount: readableChunks.length,
      currentReadableIndex,
      currentDisplayIndex: currentIndex,
      rate,
      voiceURI: selectedVoice,
      updatedAt: new Date().toISOString(),
    });
  }, [currentIndex, currentReadableIndex, fileHash, fileName, rate, readableChunks.length, selectedVoice, text.length]);

  const centerVisibleWindow = useCallback((displayIndex: number, shouldScroll = true) => {
    setVisibleWindow((previous) => clampVisibleWindow(displayIndex, displayChunks.length, previous.before, previous.after));
    if (shouldScroll) pendingScrollIndexRef.current = displayIndex;
  }, [displayChunks.length]);

  useEffect(() => {
    const targetIndex = pendingScrollIndexRef.current;
    if (targetIndex === null) return;

    const frameId = window.requestAnimationFrame(() => {
      const activeElement = readerRef.current?.querySelector(`[data-display-index="${targetIndex}"]`) as HTMLElement | null;
      activeElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (pendingScrollIndexRef.current === targetIndex) pendingScrollIndexRef.current = null;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [visibleWindow.start, visibleWindow.end, currentIndex]);

  const progress = readableChunks.length
    ? Math.min(100, Math.round(((currentReadableIndex + 1) / readableChunks.length) * 100))
    : 0;

  const visibleChunks = useMemo(
    () => displayChunks.slice(visibleWindow.start, visibleWindow.end),
    [displayChunks, visibleWindow.end, visibleWindow.start],
  );
  const searchResultSet = useMemo(() => new Set(searchResults), [searchResults]);
  const hiddenBefore = visibleWindow.start;
  const hiddenAfter = Math.max(0, displayChunks.length - visibleWindow.end);
  const isWindowedMode = displayChunks.length > LARGE_FILE_WINDOW_THRESHOLD;
  const visibleRangeText = displayChunks.length
    ? `แสดงช่วง ${(visibleWindow.start + 1).toLocaleString()}-${visibleWindow.end.toLocaleString()} จาก ${displayChunks.length.toLocaleString()}`
    : "ยังไม่มีช่วงแสดงผล";
  const readingRangeText = readableChunks.length
    ? `อ่านช่วง ${(currentReadableIndex + 1).toLocaleString()}/${readableChunks.length.toLocaleString()}`
    : "ยังไม่มีช่วงอ่าน";

  const currentVoiceName = useMemo(() => {
    return voices.find((voice) => voice.voiceURI === selectedVoice)?.name ?? "ยังไม่พบเสียงอ่าน";
  }, [selectedVoice, voices]);

  const clearSpeechTimers = useCallback(() => {
    if (watchdogTimerRef.current !== null) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (keepAliveTimerRef.current !== null) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
  }, []);

  const scheduleSpeechWatchdog = useCallback(
    (readableIndex: number, text: string) => {
      if (watchdogTimerRef.current !== null) {
        window.clearTimeout(watchdogTimerRef.current);
      }

      const estimatedMs = Math.min(
        SPEECH_WATCHDOG_MAX_MS,
        Math.max(SPEECH_WATCHDOG_MIN_MS, (text.length / Math.max(rate, 0.5)) * 95 + SPEECH_WATCHDOG_EXTRA_MS),
      );

      watchdogTimerRef.current = window.setTimeout(() => {
        if (!isPlayingRef.current || isPausedRef.current) return;
        if (currentReadableIndexRef.current !== readableIndex) return;

        const nextReadableIndex = readableIndex + 1;
        if (readableChunks[nextReadableIndex]) {
          window.speechSynthesis.cancel();
          speakChunkRef.current(nextReadableIndex);
          return;
        }

        setIsPlaying(false);
        setIsPaused(false);
      }, estimatedMs);
    },
    [rate, readableChunks],
  );

  const ensureSpeechKeepAlive = useCallback(() => {
    if (keepAliveTimerRef.current !== null) return;
    keepAliveTimerRef.current = window.setInterval(() => {
      if (!isPlayingRef.current || isPausedRef.current) return;
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, SPEECH_KEEP_ALIVE_MS);
  }, []);

  useEffect(() => {
    return () => {
      clearSpeechTimers();
      activeUtteranceRef.current = null;
      window.speechSynthesis.cancel();
    };
  }, [clearSpeechTimers]);

  const jumpToReadableChunk = useCallback(
    (readableIndex: number) => {
      const chunk = readableChunks[readableIndex];
      if (!chunk) return;
      centerVisibleWindow(chunk.displayIndex);
      setCurrentReadableIndex(readableIndex);
      setCurrentIndex(chunk.displayIndex);
    },
    [centerVisibleWindow, readableChunks],
  );

  const jumpToDisplayChunk = useCallback(
    (displayIndex: number) => {
      const chunk = displayChunks[displayIndex];
      if (!chunk) return;
      centerVisibleWindow(displayIndex);
      setCurrentIndex(displayIndex);

      const nextReadableDisplayIndex =
        chunk.readableIndex ??
        readableChunks.find((readableChunk) => readableChunk.displayIndex > displayIndex)?.displayIndex ??
        -1;

      if (chunk.readableIndex !== null) {
        setCurrentReadableIndex(chunk.readableIndex);
        return;
      }

      const fallbackReadableIndex = readableChunks.findIndex(
        (readableChunk) => readableChunk.displayIndex === nextReadableDisplayIndex,
      );
      if (fallbackReadableIndex >= 0) setCurrentReadableIndex(fallbackReadableIndex);
    },
    [centerVisibleWindow, displayChunks, readableChunks],
  );

  const processText = useCallback((rawText: string, sourceName = "ข้อความที่วาง") => {
    const processed = buildProcessedText(rawText);
    if (!processed.text || processed.readableChunks.length === 0) {
      setNotice("ยังไม่มีข้อความให้อ่าน");
      return;
    }

    const nextFileHash = hashText(`${sourceName}:${processed.text.length}:${processed.text.slice(0, 5000)}`);
    const previousSession = findResumeSession(nextFileHash);
    const safeResumeIndex = previousSession
      ? Math.min(previousSession.currentReadableIndex, processed.readableChunks.length - 1)
      : -1;
    const safeDisplayIndex = safeResumeIndex >= 0 ? processed.readableChunks[safeResumeIndex].displayIndex : 0;

    window.speechSynthesis.cancel();
    clearSpeechTimers();
    activeUtteranceRef.current = null;
    setText(processed.text);
    setFileName(sourceName);
    setFileHash(nextFileHash);
    setDisplayChunks(processed.displayChunks);
    setReadableChunks(processed.readableChunks);
    setToc(processed.toc);
    setCurrentIndex(0);
    setCurrentReadableIndex(0);
    setVisibleWindow(clampVisibleWindow(0, processed.displayChunks.length, VISIBLE_BEFORE, VISIBLE_AFTER));
    pendingScrollIndexRef.current = 0;
    setIsPlaying(false);
    setIsPaused(false);
    setSearchResults([]);
    setCurrentSearchIndex(-1);
    const cleanSummary = [
      processed.stats.removedRuleLines ? `ลบเส้นคั่น ${processed.stats.removedRuleLines} จุด` : "",
      processed.stats.splitLongParagraphs ? `ตัดย่อหน้ายาว ${processed.stats.splitLongParagraphs} จุด` : "",
      processed.stats.collapsedBlankRuns ? `ลดช่องว่าง ${processed.stats.collapsedBlankRuns} จุด` : "",
      processed.displayChunks.length > LARGE_FILE_WINDOW_THRESHOLD ? "เปิดโหมดประหยัดการแสดงผล" : "",
    ].filter(Boolean);
    setPendingResume(
      previousSession && safeResumeIndex > 0
        ? { session: previousSession, displayIndex: safeDisplayIndex, readableIndex: safeResumeIndex }
        : null,
    );
    setNotice(
      `โหลดแล้ว ${processed.text.length.toLocaleString()} ตัวอักษร · อ่านได้ ${processed.readableChunks.length.toLocaleString()} ช่วง${
        cleanSummary.length ? ` · ${cleanSummary.join(" · ")}` : ""
      }${previousSession && safeResumeIndex > 0 ? " · พบตำแหน่งอ่านล่าสุด" : ""}`,
    );
  }, [clearSpeechTimers]);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      setNotice("ขนาดไฟล์เกิน 4MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (readerEvent) => processText((readerEvent.target?.result as string) ?? "", file.name);
    reader.onerror = () => setNotice("อ่านไฟล์ไม่สำเร็จ ลองเลือกไฟล์อีกครั้ง");
    reader.readAsText(file);
  };

  const speakChunk = useCallback(
    (readableIndex: number) => {
      const chunk = readableChunks[readableIndex];
      if (!chunk) {
        setIsPlaying(false);
        setIsPaused(false);
        return;
      }

      window.speechSynthesis.cancel();
      if (watchdogTimerRef.current !== null) {
        window.clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      centerVisibleWindow(chunk.displayIndex);
      setCurrentReadableIndex(readableIndex);
      setCurrentIndex(chunk.displayIndex);
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      activeUtteranceRef.current = utterance;
      const voice = voices.find((voiceItem) => voiceItem.voiceURI === selectedVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = rate;
      utterance.onend = () => {
        if (watchdogTimerRef.current !== null) {
          window.clearTimeout(watchdogTimerRef.current);
          watchdogTimerRef.current = null;
        }
        const nextReadableIndex = readableIndex + 1;
        if (readableChunks[nextReadableIndex]) {
          window.setTimeout(() => speakChunkRef.current(nextReadableIndex), CHUNK_DELAY_MS);
          return;
        }
        activeUtteranceRef.current = null;
        clearSpeechTimers();
        setIsPlaying(false);
        setIsPaused(false);
      };
      utterance.onerror = (event) => {
        if (watchdogTimerRef.current !== null) {
          window.clearTimeout(watchdogTimerRef.current);
          watchdogTimerRef.current = null;
        }
        if (event.error === "interrupted" || event.error === "canceled") return;

        const nextReadableIndex = readableIndex + 1;
        if (isPlayingRef.current && !isPausedRef.current && readableChunks[nextReadableIndex]) {
          window.setTimeout(() => speakChunkRef.current(nextReadableIndex), CHUNK_DELAY_MS);
          return;
        }

        activeUtteranceRef.current = null;
        clearSpeechTimers();
        setIsPlaying(false);
        setIsPaused(false);
        setNotice(`ระบบอ่านเสียงหยุด: ${event.error}`);
      };

      ensureSpeechKeepAlive();
      scheduleSpeechWatchdog(readableIndex, chunk.text);
      window.speechSynthesis.speak(utterance);
    },
    [centerVisibleWindow, clearSpeechTimers, ensureSpeechKeepAlive, rate, readableChunks, scheduleSpeechWatchdog, selectedVoice, voices],
  );

  useEffect(() => {
    speakChunkRef.current = speakChunk;
  }, [speakChunk]);

  const jumpToChunk = useCallback(
    (displayIndex: number) => {
      const chunk = displayChunks[displayIndex];
      if (!chunk) return;
      jumpToDisplayChunk(displayIndex);
      if (isPlaying && !isPaused) {
        const readableIndex = chunk.readableIndex ?? currentReadableIndex;
        speakChunk(readableIndex);
      }
    },
    [currentReadableIndex, displayChunks, isPaused, isPlaying, jumpToDisplayChunk, speakChunk],
  );

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setCurrentSearchIndex(-1);
      return;
    }

    const query = searchQuery.toLowerCase();
    const results = displayChunks.reduce<number[]>((matches, chunk, index) => {
      if (chunk.text.toLowerCase().includes(query)) matches.push(index);
      return matches;
    }, []);

    setSearchResults(results);
    if (results.length) {
      setCurrentSearchIndex(0);
      jumpToChunk(results[0]);
    } else {
      setNotice("ไม่พบข้อความที่ค้นหา");
    }
  };

  const nextSearchResult = () => {
    if (!searchResults.length) return;
    const nextIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(nextIndex);
    jumpToChunk(searchResults[nextIndex]);
  };

  const togglePlay = () => {
    if (!readableChunks.length) {
      setNotice("เพิ่มข้อความก่อนเริ่มอ่าน");
      return;
    }

    if (isPlaying && !isPaused) {
      if (watchdogTimerRef.current !== null) {
        window.clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      window.speechSynthesis.pause();
      setIsPaused(true);
      return;
    }

    if (isPlaying && isPaused) {
      window.speechSynthesis.resume();
      const chunk = readableChunks[currentReadableIndex];
      if (chunk) scheduleSpeechWatchdog(currentReadableIndex, chunk.text);
      ensureSpeechKeepAlive();
      setIsPaused(false);
      return;
    }

    setIsPlaying(true);
    setIsPaused(false);
    speakChunk(currentReadableIndex);
  };

  const stopReading = () => {
    clearSpeechTimers();
    activeUtteranceRef.current = null;
    window.speechSynthesis.cancel();
    setIsPlaying(false);
    setIsPaused(false);
  };

  const moveChunk = (offset: number) => {
    const target = Math.max(0, Math.min(readableChunks.length - 1, currentReadableIndex + offset));
    jumpToReadableChunk(target);
    if (isPlaying && !isPaused) speakChunk(target);
  };

  const resumeFromSavedPosition = () => {
    if (!pendingResume) return;
    const { session, readableIndex } = pendingResume;
    setRate(session.rate);
    if (session.voiceURI) setSelectedVoice(session.voiceURI);
    jumpToReadableChunk(readableIndex);
    setPendingResume(null);
    setNotice(`อ่านต่อจากครั้งล่าสุดที่ช่วง ${readableIndex + 1}/${readableChunks.length}`);
  };

  const startFromBeginning = () => {
    stopReading();
    jumpToReadableChunk(0);
    setPendingResume(null);
    setNotice("เริ่มอ่านจากต้นไฟล์");
  };

  const signedInEmail = authUser?.email?.toLowerCase() ?? "";
  const isAllowedUser = Boolean(authUser) && (ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes(signedInEmail));

  const sendMagicLink = async () => {
    if (!supabase || !authEmail.trim()) return;
    setAuthBusy(true);
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithOtp({
      email: authEmail.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthBusy(false);
    setAuthMessage(error ? error.message : "ส่งลิงก์เข้าสู่ระบบไปที่อีเมลแล้ว");
  };

  const signOut = async () => {
    stopReading();
    await supabase?.auth.signOut();
    setAuthMessage("ออกจากระบบแล้ว");
  };

  const focusCurrentPosition = () => centerVisibleWindow(currentIndex);

  const expandVisibleWindow = () => {
    setVisibleWindow((previous) =>
      clampVisibleWindow(
        currentIndex,
        displayChunks.length,
        previous.before + VISIBLE_EXPAND_STEP,
        previous.after + VISIBLE_EXPAND_STEP,
      ),
    );
  };

  const revealPreviousWindow = () => {
    setVisibleWindow((previous) => ({
      ...previous,
      start: Math.max(0, previous.start - VISIBLE_EXPAND_STEP),
    }));
  };

  const revealNextWindow = () => {
    setVisibleWindow((previous) => ({
      ...previous,
      end: Math.min(displayChunks.length, previous.end + VISIBLE_EXPAND_STEP),
    }));
  };

  if (!authConfigured) {
    return (
      <main className="min-h-screen bg-[#080706] px-4 py-8 text-[#f3ead7]">
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl items-center">
          <section className="w-full rounded border border-[#d7ad65]/30 bg-[#15100c]/90 p-6 shadow-2xl shadow-black/40 md:p-8">
            <p className="text-xs font-semibold uppercase text-[#d7ad65]">Supabase setup required</p>
            <h1 className="mt-3 text-3xl font-black text-[#fff6df]">ตั้งค่า Auth ก่อนเปิดใช้งาน</h1>
            <p className="mt-4 text-sm leading-7 text-[#c9baa2]">
              เว็บถูกตั้งให้ป้องกันด้วย Supabase Auth แล้ว เพิ่ม env เหล่านี้ในเครื่องหรือ server แล้ว rebuild อีกครั้ง
            </p>
            <pre className="mt-5 overflow-x-auto rounded border border-[#d7ad65]/20 bg-black/45 p-4 text-xs leading-6 text-[#ffe2a3]">
{`NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_ALLOWED_EMAILS=your@email.com`}
            </pre>
          </section>
        </div>
      </main>
    );
  }

  if (authLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#080706] px-4 text-[#f3ead7]">
        <div className="rounded border border-[#d7ad65]/30 bg-[#15100c]/90 px-6 py-5 text-sm text-[#d7ad65] shadow-2xl shadow-black/40">
          กำลังตรวจสอบ session...
        </div>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="min-h-screen bg-[#080706] px-4 py-8 text-[#f3ead7]">
        <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center">
          <section className="w-full rounded border border-[#d7ad65]/30 bg-[#15100c]/90 p-6 shadow-2xl shadow-black/40 md:p-8">
            <p className="text-xs font-semibold uppercase text-[#d7ad65]">Private Audio Reader</p>
            <h1 className="mt-3 text-3xl font-black text-[#fff6df]">เข้าสู่ระบบ</h1>
            <p className="mt-3 text-sm leading-6 text-[#c9baa2]">
              พื้นที่นี้ถูกล็อกไว้สำหรับผู้ใช้ที่อนุญาตเท่านั้น
            </p>
            <div className="mt-6 space-y-3">
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && sendMagicLink()}
                placeholder="email"
                className="w-full rounded border border-[#d7ad65]/25 bg-[#090807] px-4 py-3 text-sm text-[#f3ead7] outline-none focus:border-[#d7ad65]"
              />
              <button
                onClick={sendMagicLink}
                disabled={authBusy}
                className="w-full rounded bg-[#d7ad65] px-5 py-3 text-sm font-black text-[#17100c] transition hover:bg-[#f0c97f] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {authBusy ? "กำลังส่งลิงก์..." : "ส่งลิงก์เข้าสู่ระบบ"}
              </button>
            </div>
            {authMessage && <p className="mt-4 text-sm leading-6 text-[#c9baa2]">{authMessage}</p>}
          </section>
        </div>
      </main>
    );
  }

  if (!isAllowedUser) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#080706] px-4 text-[#f3ead7]">
        <section className="w-full max-w-md rounded border border-[#d7ad65]/30 bg-[#15100c]/90 p-6 shadow-2xl shadow-black/40">
          <p className="text-xs font-semibold uppercase text-[#d7ad65]">Access blocked</p>
          <h1 className="mt-3 text-2xl font-black text-[#fff6df]">อีเมลนี้ยังไม่ได้รับอนุญาต</h1>
          <p className="mt-3 text-sm leading-6 text-[#c9baa2]">
            กำลัง login ด้วย {authUser.email} แต่ไม่อยู่ใน allowlist ของระบบ
          </p>
          <button
            onClick={signOut}
            className="mt-5 rounded border border-[#d7ad65]/40 px-5 py-2.5 text-sm font-bold text-[#ffe2a3] hover:bg-[#d7ad65]/10"
          >
            ออกจากระบบ
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#080706] text-[#f3ead7]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(213,171,91,0.26),transparent_28%),radial-gradient(circle_at_82%_20%,rgba(93,134,163,0.18),transparent_32%),linear-gradient(135deg,#0a0806_0%,#17100c_42%,#070707_100%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-45 [background-image:linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] [background-size:56px_56px]" />

      <section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-[#d7ad65]/25 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs font-semibold uppercase text-[#d7ad65]">Black Desert Inspired Reader</p>
              <span className="rounded border border-[#d7ad65]/25 bg-black/30 px-2.5 py-1 text-[11px] text-[#c9baa2]">
                {authUser.email}
              </span>
              <button
                onClick={signOut}
                className="rounded border border-[#d7ad65]/30 px-2.5 py-1 text-[11px] font-bold text-[#ffe2a3] hover:bg-[#d7ad65]/10"
              >
                Logout
              </button>
            </div>
            <h1 className="mt-2 text-3xl font-black text-[#fff6df] sm:text-5xl">Audio Reader</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#c7b89e]">
              อัปโหลดไฟล์นิยายหรือวางข้อความ แล้วให้ระบบอ่านออกเสียงพร้อมไฮไลต์ตำแหน่งแบบเรียลไทม์
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded border border-[#d7ad65]/25 bg-black/35 p-2 text-center shadow-2xl shadow-black/30 backdrop-blur">
            <div className="px-3 py-2">
              <p className="text-lg font-bold text-[#ffe2a3]">{readableChunks.length}</p>
              <p className="text-[11px] text-[#a99a82]">ช่วงอ่าน</p>
            </div>
            <div className="border-x border-[#d7ad65]/20 px-3 py-2">
              <p className="text-lg font-bold text-[#ffe2a3]">{toc.length}</p>
              <p className="text-[11px] text-[#a99a82]">บทที่พบ</p>
            </div>
            <div className="px-3 py-2">
              <p className="text-lg font-bold text-[#ffe2a3]">{progress}%</p>
              <p className="text-[11px] text-[#a99a82]">ความคืบหน้า</p>
            </div>
          </div>
        </header>

        {!displayChunks.length ? (
          <div className="grid flex-1 gap-5 lg:grid-cols-[0.95fr_1.05fr] lg:items-stretch">
            <div className="flex flex-col justify-between rounded border border-[#d7ad65]/30 bg-[#15100c]/80 p-6 shadow-2xl shadow-black/40 backdrop-blur md:p-8">
              <div>
                <p className="text-sm font-semibold text-[#d7ad65]">เริ่มต้นการผจญภัย</p>
                <h2 className="mt-3 text-3xl font-black text-[#fff6df]">นำเข้าไฟล์ .txt หรือใช้ตัวอย่าง</h2>
                <p className="mt-4 text-sm leading-7 text-[#c9baa2]">{notice}</p>
              </div>
              <div className="mt-8 flex flex-wrap gap-3">
                <label className="cursor-pointer rounded bg-[#d7ad65] px-5 py-3 text-sm font-bold text-[#17100c] shadow-lg shadow-[#d7ad65]/10 transition hover:bg-[#f0c97f]">
                  เลือกไฟล์ข้อความ
                  <input type="file" accept=".txt,text/plain" onChange={handleFileUpload} className="hidden" />
                </label>
                <button
                  onClick={() => processText(SAMPLE_TEXT)}
                  className="rounded border border-[#d7ad65]/45 px-5 py-3 text-sm font-bold text-[#ffe2a3] transition hover:border-[#f0c97f] hover:bg-[#d7ad65]/10"
                >
                  เปิดตัวอย่าง
                </button>
              </div>
            </div>

            <div className="rounded border border-[#d7ad65]/20 bg-black/45 p-4 shadow-2xl shadow-black/30 backdrop-blur">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="วางข้อความที่นี่ แล้วกดปุ่มโหลดข้อความ..."
                className="bdo-scrollbar min-h-[360px] w-full resize-none rounded border border-[#d7ad65]/25 bg-[#090807]/80 p-5 text-base leading-8 text-[#f3ead7] outline-none transition placeholder:text-[#776b5b] focus:border-[#d7ad65]"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-[#a99a82]">รองรับภาษาไทยและเสียงอ่านที่มีในเครื่อง</p>
                <button
                  onClick={() => processText(text)}
                  className="rounded bg-[#f3ead7] px-5 py-2.5 text-sm font-bold text-[#17100c] transition hover:bg-white"
                >
                  โหลดข้อความ
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid flex-1 gap-5 lg:grid-cols-[290px_minmax(0,1fr)]">
            <aside className="flex min-h-[240px] flex-col gap-4 rounded border border-[#d7ad65]/25 bg-black/40 p-4 shadow-2xl shadow-black/30 backdrop-blur">
              <label className="rounded border border-[#d7ad65]/25 bg-[#120f0c] px-4 py-3 text-sm font-bold text-[#ffe2a3] transition hover:border-[#d7ad65]">
                เปลี่ยนไฟล์
                <input type="file" accept=".txt,text/plain" onChange={handleFileUpload} className="hidden" />
              </label>

              <div>
                <p className="mb-2 text-xs font-bold uppercase text-[#d7ad65]">ค้นหา</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && handleSearch()}
                    placeholder="คำที่ต้องการหา"
                    className="min-w-0 flex-1 rounded border border-[#d7ad65]/25 bg-[#090807] px-3 py-2 text-sm text-[#f3ead7] outline-none focus:border-[#d7ad65]"
                  />
                  <button onClick={handleSearch} className="rounded bg-[#d7ad65] px-3 text-sm font-bold text-[#17100c]">
                    หา
                  </button>
                </div>
                {searchResults.length > 0 && (
                  <button onClick={nextSearchResult} className="mt-2 w-full rounded border border-[#d7ad65]/35 py-2 text-xs text-[#ffe2a3]">
                    ผลลัพธ์ถัดไป {currentSearchIndex + 1}/{searchResults.length}
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1">
                <p className="mb-2 text-xs font-bold uppercase text-[#d7ad65]">สารบัญ</p>
                <div className="bdo-scrollbar max-h-[42vh] space-y-2 overflow-y-auto pr-1">
                  {toc.length === 0 ? (
                    <p className="rounded border border-[#d7ad65]/15 bg-[#120f0c]/70 p-3 text-sm text-[#8f816d]">
                      ไม่พบหัวข้อรูปแบบ &quot;บทที่&quot; หรือ &quot;ตอนที่&quot;
                    </p>
                  ) : (
                    toc.map((item, idx) => (
                      <button
                        key={`${item.chunkIndex}-${idx}`}
                        onClick={() => jumpToChunk(item.chunkIndex)}
                        className="w-full rounded border border-transparent px-3 py-2 text-left text-sm text-[#c9baa2] transition hover:border-[#d7ad65]/30 hover:bg-[#d7ad65]/10 hover:text-[#fff6df]"
                      >
                        {item.title}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </aside>

            <section className="flex min-h-[70vh] flex-col rounded border border-[#d7ad65]/25 bg-[#12100d]/80 shadow-2xl shadow-black/40 backdrop-blur">
              <div className="grid gap-3 border-b border-[#d7ad65]/20 p-4 xl:grid-cols-[1fr_auto] xl:items-center">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                  <select
                    value={selectedVoice}
                    onChange={(event) => setSelectedVoice(event.target.value)}
                    className="rounded border border-[#d7ad65]/25 bg-[#090807] px-3 py-2 text-sm text-[#f3ead7] outline-none focus:border-[#d7ad65]"
                  >
                    {voices.map((voice) => (
                      <option key={voice.voiceURI} value={voice.voiceURI}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-3 rounded border border-[#d7ad65]/20 bg-black/30 px-3 py-2 text-sm text-[#c9baa2]">
                    {rate.toFixed(1)}x
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={rate}
                      onChange={(event) => setRate(parseFloat(event.target.value))}
                      className="w-full accent-[#d7ad65]"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => moveChunk(-1)} className="rounded border border-[#d7ad65]/30 px-4 py-2 text-sm text-[#ffe2a3] hover:bg-[#d7ad65]/10">
                    ก่อนหน้า
                  </button>
                  <button onClick={togglePlay} className="rounded bg-[#d7ad65] px-6 py-2 text-sm font-black text-[#17100c] hover:bg-[#f0c97f]">
                    {isPlaying && !isPaused ? "พัก" : isPaused ? "อ่านต่อ" : "เริ่มอ่าน"}
                  </button>
                  <button onClick={stopReading} className="rounded border border-[#d7ad65]/30 px-4 py-2 text-sm text-[#ffe2a3] hover:bg-[#d7ad65]/10">
                    หยุด
                  </button>
                  <button onClick={() => moveChunk(1)} className="rounded border border-[#d7ad65]/30 px-4 py-2 text-sm text-[#ffe2a3] hover:bg-[#d7ad65]/10">
                    ถัดไป
                  </button>
                </div>
              </div>

              <div className="h-1 bg-black/50">
                <div className="h-full bg-gradient-to-r from-[#7a562d] via-[#d7ad65] to-[#fff0bd]" style={{ width: `${progress}%` }} />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d7ad65]/15 px-4 py-3 text-xs text-[#a99a82]">
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{fileName ? `${fileName} · ` : ""}{notice}</span>
                  <span className="mt-1 block text-[#d7ad65]">
                    {visibleRangeText} · {readingRangeText}
                    {isWindowedMode ? " · โหมดไฟล์ใหญ่" : ""}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={focusCurrentPosition}
                    className="rounded border border-[#d7ad65]/40 px-3 py-1.5 text-xs font-bold text-[#ffe2a3] hover:bg-[#d7ad65]/10"
                  >
                    ไปยังตำแหน่งที่อ่าน
                  </button>
                  {isWindowedMode && (
                    <button
                      onClick={expandVisibleWindow}
                      className="rounded border border-[#5d86a3]/45 px-3 py-1.5 text-xs font-bold text-[#cfe8f7] hover:bg-[#5d86a3]/10"
                    >
                      ขยายช่วงแสดงผล
                    </button>
                  )}
                  {pendingResume && (
                    <>
                    <button
                      onClick={resumeFromSavedPosition}
                      className="rounded border border-[#d7ad65]/40 px-3 py-1.5 text-xs font-bold text-[#ffe2a3] hover:bg-[#d7ad65]/10"
                    >
                      อ่านต่อ
                    </button>
                    <button
                      onClick={startFromBeginning}
                      className="rounded border border-[#5d86a3]/45 px-3 py-1.5 text-xs font-bold text-[#cfe8f7] hover:bg-[#5d86a3]/10"
                    >
                      เริ่มใหม่
                    </button>
                    </>
                  )}
                </div>
                <span className="truncate text-right">{currentVoiceName}</span>
              </div>

              <div ref={readerRef} className="bdo-scrollbar flex-1 overflow-y-auto p-5 text-lg leading-9 md:p-8 md:text-xl md:leading-10">
                {hiddenBefore > 0 && (
                  <button
                    onClick={revealPreviousWindow}
                    className="mb-4 block w-full rounded border border-[#d7ad65]/25 bg-black/25 px-3 py-2 text-center text-sm text-[#d7ad65] hover:bg-[#d7ad65]/10"
                  >
                    ก่อนหน้านี้ {hiddenBefore.toLocaleString()} ช่วง
                  </button>
                )}
                {visibleChunks.map((chunk, offset) => {
                  const index = visibleWindow.start + offset;
                  const isMatch = searchResultSet.has(index);
                  return (
                    <button
                      key={`${chunk.start}-${index}`}
                      data-display-index={index}
                      onClick={() => jumpToChunk(index)}
                      className={`block w-full whitespace-pre-wrap rounded px-3 py-2 text-left transition ${
                        index === currentIndex
                          ? "active-chunk border-l-4 border-[#d7ad65] bg-[#d7ad65]/16 text-[#fff6df] shadow-lg shadow-[#d7ad65]/10"
                          : isMatch
                            ? "bg-[#5d86a3]/18 text-white"
                            : "text-[#cbbda6] hover:bg-white/5 hover:text-[#fff6df]"
                      }`}
                    >
                      {chunk.text}
                    </button>
                  );
                })}
                {hiddenAfter > 0 && (
                  <button
                    onClick={revealNextWindow}
                    className="mt-4 block w-full rounded border border-[#d7ad65]/25 bg-black/25 px-3 py-2 text-center text-sm text-[#d7ad65] hover:bg-[#d7ad65]/10"
                  >
                    หลังจากนี้ {hiddenAfter.toLocaleString()} ช่วง
                  </button>
                )}
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
