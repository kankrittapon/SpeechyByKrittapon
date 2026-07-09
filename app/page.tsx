"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const SAMPLE_TEXT = `บทที่ 1 เสียงจากทะเลทราย

ลมร้อนพัดผ่านซากหินสีดำ ขณะที่นักผจญภัยหยุดยืนหน้าประตูโบราณ แสงสีทองค่อย ๆ ไหลไปตามรอยสลักราวกับมันกำลังตื่นจากการหลับใหลยาวนาน

ตอนที่ 2 คำสัญญาของนักเดินทาง

ไม่มีใครรู้ว่าปลายทางอยู่ที่ใด แต่ทุกคนรู้ว่าการเดินทางครั้งนี้จะเปลี่ยนพวกเขาไปตลอดกาล`;

interface Chunk {
  text: string;
  start: number;
  end: number;
}

interface TocItem {
  title: string;
  chunkIndex: number;
}

export default function AudioReader() {
  const [text, setText] = useState("");
  const [displayChunks, setDisplayChunks] = useState<Chunk[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [notice, setNotice] = useState("พร้อมรับไฟล์ .txt หรือวางข้อความเพื่อเริ่มอ่าน");

  const readerRef = useRef<HTMLDivElement>(null);

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
    const activeElement = readerRef.current?.querySelector(".active-chunk") as HTMLElement | null;
    activeElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentIndex]);

  const progress = displayChunks.length
    ? Math.min(100, Math.round(((currentIndex + 1) / displayChunks.length) * 100))
    : 0;

  const currentVoiceName = useMemo(() => {
    return voices.find((voice) => voice.voiceURI === selectedVoice)?.name ?? "ยังไม่พบเสียงอ่าน";
  }, [selectedVoice, voices]);

  const processText = useCallback((rawText: string) => {
    const cleanedText = rawText.replace(/\r\n/g, "\n").trim();
    if (!cleanedText) {
      setNotice("ยังไม่มีข้อความให้อ่าน");
      return;
    }

    const finalChunks = cleanedText
      .split(/(\n{2,}|[^\n]+(?:\n)?)/g)
      .filter(Boolean)
      .map((line, index) => ({
        text: line,
        start: index,
        end: index + line.length,
      }));

    const generatedToc: TocItem[] = [];
    finalChunks.forEach((chunk, index) => {
      const match = chunk.text.match(/^\s*(ตอนที่|บทที่|chapter)\s*[\wก-๙ .:-]+/i);
      if (match) {
        generatedToc.push({ title: chunk.text.trim().slice(0, 80), chunkIndex: index });
      }
    });

    window.speechSynthesis.cancel();
    setText(cleanedText);
    setDisplayChunks(finalChunks);
    setToc(generatedToc);
    setCurrentIndex(0);
    setIsPlaying(false);
    setIsPaused(false);
    setSearchResults([]);
    setCurrentSearchIndex(-1);
    setNotice(`โหลดข้อความแล้ว ${cleanedText.length.toLocaleString()} ตัวอักษร`);
  }, []);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      setNotice("ขนาดไฟล์เกิน 4MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (readerEvent) => processText((readerEvent.target?.result as string) ?? "");
    reader.onerror = () => setNotice("อ่านไฟล์ไม่สำเร็จ ลองเลือกไฟล์อีกครั้ง");
    reader.readAsText(file);
  };

  const speakChunk = useCallback(
    (index: number) => {
      if (index >= displayChunks.length) {
        setIsPlaying(false);
        setIsPaused(false);
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(displayChunks[index].text);
      const voice = voices.find((voiceItem) => voiceItem.voiceURI === selectedVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = rate;
      utterance.onend = () => {
        setCurrentIndex((previous) => {
          const next = previous + 1;
          if (next < displayChunks.length) {
            window.setTimeout(() => speakChunk(next), 80);
          } else {
            setIsPlaying(false);
            setIsPaused(false);
          }
          return Math.min(next, displayChunks.length - 1);
        });
      };

      window.speechSynthesis.speak(utterance);
    },
    [displayChunks, rate, selectedVoice, voices],
  );

  const jumpToChunk = useCallback(
    (index: number) => {
      if (!displayChunks[index]) return;
      setCurrentIndex(index);
      if (isPlaying && !isPaused) speakChunk(index);
    },
    [displayChunks, isPaused, isPlaying, speakChunk],
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
    if (!displayChunks.length) {
      setNotice("เพิ่มข้อความก่อนเริ่มอ่าน");
      return;
    }

    if (isPlaying && !isPaused) {
      window.speechSynthesis.pause();
      setIsPaused(true);
      return;
    }

    if (isPlaying && isPaused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
      return;
    }

    setIsPlaying(true);
    setIsPaused(false);
    speakChunk(currentIndex);
  };

  const stopReading = () => {
    window.speechSynthesis.cancel();
    setIsPlaying(false);
    setIsPaused(false);
  };

  const moveChunk = (offset: number) => {
    jumpToChunk(Math.max(0, Math.min(displayChunks.length - 1, currentIndex + offset)));
  };

  return (
    <main className="min-h-screen overflow-hidden bg-[#080706] text-[#f3ead7]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(213,171,91,0.26),transparent_28%),radial-gradient(circle_at_82%_20%,rgba(93,134,163,0.18),transparent_32%),linear-gradient(135deg,#0a0806_0%,#17100c_42%,#070707_100%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-45 [background-image:linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] [background-size:56px_56px]" />

      <section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-[#d7ad65]/25 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-[#d7ad65]">Black Desert Inspired Reader</p>
            <h1 className="mt-2 text-3xl font-black text-[#fff6df] sm:text-5xl">Audio Reader</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#c7b89e]">
              อัปโหลดไฟล์นิยายหรือวางข้อความ แล้วให้ระบบอ่านออกเสียงพร้อมไฮไลต์ตำแหน่งแบบเรียลไทม์
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded border border-[#d7ad65]/25 bg-black/35 p-2 text-center shadow-2xl shadow-black/30 backdrop-blur">
            <div className="px-3 py-2">
              <p className="text-lg font-bold text-[#ffe2a3]">{displayChunks.length}</p>
              <p className="text-[11px] text-[#a99a82]">ช่วงข้อความ</p>
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

              <div className="flex items-center justify-between gap-3 border-b border-[#d7ad65]/15 px-4 py-3 text-xs text-[#a99a82]">
                <span>{notice}</span>
                <span className="truncate text-right">{currentVoiceName}</span>
              </div>

              <div ref={readerRef} className="bdo-scrollbar flex-1 overflow-y-auto p-5 text-lg leading-9 md:p-8 md:text-xl md:leading-10">
                {displayChunks.map((chunk, index) => {
                  const isMatch = searchResults.includes(index);
                  return (
                    <button
                      key={`${chunk.start}-${index}`}
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
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
