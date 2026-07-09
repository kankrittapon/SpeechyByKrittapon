"use client";

import { useEffect, useState, useRef } from "react";

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB

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

  // TOC and Search
  const [toc, setToc] = useState<TocItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);

  const readerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();
      availableVoices.sort((a, b) => {
        if (a.lang.includes("th") && !b.lang.includes("th")) return -1;
        if (!a.lang.includes("th") && b.lang.includes("th")) return 1;
        return 0;
      });
      setVoices(availableVoices);
      
      const savedVoice = localStorage.getItem("savedVoice");
      const savedRate = localStorage.getItem("savedRate");
      
      if (savedVoice && availableVoices.find(v => v.voiceURI === savedVoice)) {
        setSelectedVoice(savedVoice);
      } else if (availableVoices.length > 0) {
        const defaultTh = availableVoices.find(v => v.lang.includes("th") && v.default) || availableVoices.find(v => v.lang.includes("th")) || availableVoices[0];
        setSelectedVoice(defaultTh.voiceURI);
      }
      
      if (savedRate) setRate(parseFloat(savedRate));
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  useEffect(() => {
    if (selectedVoice) localStorage.setItem("savedVoice", selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem("savedRate", rate.toString());
  }, [rate]);

  // Auto-scroll to current reading position
  useEffect(() => {
    if (readerRef.current) {
      const activeElement = readerRef.current.querySelector(".active-chunk") as HTMLElement;
      if (activeElement) {
        readerRef.current.scrollTo({
          top: activeElement.offsetTop - readerRef.current.offsetTop - 100,
          behavior: 'smooth'
        });
      }
    }
  }, [currentIndex]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      alert("ขนาดไฟล์เกิน 4MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setText(result);
      processText(result);
    };
    reader.readAsText(file);
  };

  const processText = (rawText: string) => {
    const dChunks: Chunk[] = [];
    const matches = rawText.matchAll(/([^\n]+[\n]*)|(\n+)/g);
    for (const match of matches) {
      dChunks.push({ text: match[0], start: match.index!, end: match.index! + match[0].length });
    }
    const finalChunks = dChunks.length > 0 ? dChunks : [{ text: rawText, start: 0, end: rawText.length }];
    setDisplayChunks(finalChunks);
    
    // Generate TOC
    const generatedToc: TocItem[] = [];
    finalChunks.forEach((chunk, index) => {
      const match = chunk.text.match(/(ตอนที่|บทที่)\s*[\d.]+/);
      if (match) {
        generatedToc.push({ title: chunk.text.trim(), chunkIndex: index });
      }
    });
    setToc(generatedToc);
    setCurrentIndex(0);
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setCurrentSearchIndex(-1);
      return;
    }
    const results: number[] = [];
    displayChunks.forEach((chunk, idx) => {
      if (chunk.text.toLowerCase().includes(searchQuery.toLowerCase())) {
        results.push(idx);
      }
    });
    setSearchResults(results);
    if (results.length > 0) {
      setCurrentSearchIndex(0);
      jumpToChunk(results[0]);
    } else {
      alert("ไม่พบข้อความที่ค้นหา");
    }
  };

  const nextSearchResult = () => {
    if (searchResults.length > 0) {
      const nextIdx = (currentSearchIndex + 1) % searchResults.length;
      setCurrentSearchIndex(nextIdx);
      jumpToChunk(searchResults[nextIdx]);
    }
  };

  const jumpToChunk = (index: number) => {
    setCurrentIndex(index);
    if (isPlaying && !isPaused) {
      window.speechSynthesis.cancel();
      speakChunk(index);
    }
  };

  const togglePlay = () => {
    if (isPlaying && !isPaused) {
      window.speechSynthesis.pause();
      setIsPaused(true);
    } else if (isPlaying && isPaused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    } else {
      setIsPlaying(true);
      setIsPaused(false);
      speakChunk(currentIndex);
    }
  };

  const speakChunk = (index: number) => {
    if (index >= displayChunks.length) {
      setIsPlaying(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(displayChunks[index].text);
    const voice = voices.find(v => v.voiceURI === selectedVoice);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = rate;
    
    utterance.onend = () => {
      setCurrentIndex(prev => {
        const next = prev + 1;
        if (next < displayChunks.length) {
          setTimeout(() => speakChunk(next), 50); // slight delay prevents stuttering
        } else {
          setIsPlaying(false);
        }
        return next;
      });
    };

    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="min-h-screen bg-[#1c1a17] text-[#d4c4a8] font-serif p-4 md:p-8" style={{ backgroundImage: "radial-gradient(circle at center, #2a2520 0%, #11100e 100%)" }}>
      {/* Header */}
      <header className="mb-8 text-center border-b border-[#8c734b]/30 pb-4">
        <h1 className="text-4xl font-bold text-[#e3c565] tracking-widest uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
          Black Desert Reader
        </h1>
        <p className="text-[#a89984] text-sm mt-2">Speechy Text-to-Speech System</p>
      </header>

      {!text ? (
        <div className="max-w-md mx-auto mt-20 text-center border border-[#8c734b] bg-black/40 p-12 rounded backdrop-blur-sm shadow-[0_0_15px_rgba(227,197,101,0.1)] transition-all hover:shadow-[0_0_25px_rgba(227,197,101,0.2)]">
          <h2 className="text-2xl font-bold mb-6 text-[#e3c565]">อัปโหลดบันทึกการผจญภัย (.txt)</h2>
          <label className="cursor-pointer inline-block px-6 py-3 border border-[#8c734b] text-[#e3c565] hover:bg-[#8c734b]/20 transition-colors uppercase tracking-wider text-sm">
            เลือกไฟล์จากกระเป๋า
            <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      ) : (
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-6">
          
          {/* Left Sidebar: TOC */}
          <div className="md:col-span-1 bg-black/50 border border-[#8c734b]/50 p-4 h-[75vh] overflow-y-auto custom-scrollbar">
            <h3 className="text-[#e3c565] text-lg font-bold border-b border-[#8c734b]/30 pb-2 mb-4">สารบัญ (บท)</h3>
            <ul className="space-y-2">
              {toc.length === 0 ? <li className="text-sm text-gray-500">ไม่มีข้อมูลสารบัญ</li> : null}
              {toc.map((item, idx) => (
                <li key={idx} 
                    className="cursor-pointer text-sm hover:text-[#e3c565] transition-colors truncate"
                    onClick={() => jumpToChunk(item.chunkIndex)}>
                  ◆ {item.title}
                </li>
              ))}
            </ul>
          </div>

          {/* Main Content: Reader */}
          <div className="md:col-span-3 flex flex-col gap-4 h-[75vh]">
            
            {/* Toolbar */}
            <div className="flex flex-wrap gap-4 justify-between items-center bg-black/50 border border-[#8c734b]/50 p-3">
              
              <div className="flex items-center gap-2">
                <select 
                  value={selectedVoice} 
                  onChange={e => setSelectedVoice(e.target.value)} 
                  className="bg-[#1c1a17] border border-[#8c734b] text-[#d4c4a8] p-2 text-sm outline-none focus:border-[#e3c565]"
                >
                  {voices.map(v => (
                    <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                  ))}
                </select>
                
                <div className="flex items-center gap-2 px-2">
                  <span className="text-sm text-[#8c734b]">ความเร็ว:</span>
                  <input type="range" min="0.5" max="2" step="0.1" value={rate} onChange={e => setRate(parseFloat(e.target.value))} className="accent-[#e3c565] w-24" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input 
                  type="text" 
                  value={searchQuery} 
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="ค้นหาข้อความ..." 
                  className="bg-[#1c1a17] border border-[#8c734b] text-[#d4c4a8] p-1.5 text-sm outline-none px-3"
                />
                <button onClick={handleSearch} className="px-3 py-1.5 border border-[#8c734b] text-[#8c734b] hover:text-[#e3c565] hover:border-[#e3c565] text-sm transition-colors">
                  ค้นหา
                </button>
                {searchResults.length > 0 && (
                  <button onClick={nextSearchResult} className="px-3 py-1.5 border border-[#8c734b] text-[#8c734b] hover:text-[#e3c565] hover:border-[#e3c565] text-sm transition-colors">
                    ถัดไป ({currentSearchIndex + 1}/{searchResults.length})
                  </button>
                )}
              </div>

              <button 
                onClick={togglePlay} 
                className="bg-[#8c734b] hover:bg-[#e3c565] text-black px-6 py-2 font-bold transition-colors uppercase tracking-widest shadow-[0_0_10px_rgba(227,197,101,0.2)]"
              >
                {isPlaying && !isPaused ? 'หยุดพัก' : 'เริ่มอ่าน'}
              </button>
            </div>

            {/* Reader Box (Scroll hidden per request, auto-scrolls to active) */}
            <div 
              ref={readerRef}
              className="flex-1 bg-black/40 border border-[#8c734b]/30 p-6 md:p-10 overflow-y-hidden leading-[2.2] text-lg whitespace-pre-wrap relative"
              style={{ boxShadow: 'inset 0 0 50px rgba(0,0,0,0.8)' }}
            >
              {displayChunks.map((chunk, i) => {
                const isMatch = searchResults.includes(i);
                return (
                  <span 
                    key={i} 
                    className={`cursor-pointer transition-colors duration-300 ${
                      i === currentIndex 
                        ? "active-chunk bg-[#e3c565]/20 text-[#e3c565] border-l-2 border-[#e3c565] pl-2 -ml-[10px]" 
                        : isMatch
                        ? "bg-[#8c734b]/30 text-white"
                        : "text-[#a89984] hover:text-[#d4c4a8]"
                    }`}
                    onClick={() => jumpToChunk(i)}
                  >
                    {chunk.text}
                  </span>
                )
              })}
            </div>
            
          </div>
        </div>
      )}
      
      {/* Global styles for custom scrollbar */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.5);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #8c734b;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #e3c565;
        }
      `}} />
    </div>
  );
}
