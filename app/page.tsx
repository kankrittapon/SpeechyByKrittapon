"use client";

import { useEffect, useState, useRef } from "react";

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB
const MAX_SPEECH_CHUNK_LENGTH = 150;

export default function AudioReader() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [displayChunks, setDisplayChunks] = useState<any[]>([]);
  const [speechChunks, setSpeechChunks] = useState<any[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();
      availableVoices.sort((a, b) => {
        if (a.lang.includes("th") && !b.lang.includes("th")) return -1;
        if (!a.lang.includes("th") && b.lang.includes("th")) return 1;
        return 0;
      });
      setVoices(availableVoices);
      if (availableVoices.length > 0 && !selectedVoice) {
        const defaultTh = availableVoices.find(v => v.lang.includes("th") && v.default) || availableVoices.find(v => v.lang.includes("th")) || availableVoices[0];
        setSelectedVoice(defaultTh.voiceURI);
      }
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

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
    // Basic chunking logic similar to vanilla app
    const dChunks = [];
    const matches = rawText.matchAll(/([^\n]+[\n]*)|(\n+)/g);
    for (const match of matches) {
      dChunks.push({ text: match[0], start: match.index, end: match.index! + match[0].length });
    }
    setDisplayChunks(dChunks.length > 0 ? dChunks : [{ text: rawText, start: 0, end: rawText.length }]);
    
    // Simplification for React version
    setSpeechChunks(dChunks);
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
          setTimeout(() => speakChunk(next), 10);
        } else {
          setIsPlaying(false);
        }
        return next;
      });
    };

    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-8">
      {!text ? (
        <div className="max-w-md mx-auto text-center border-2 border-dashed border-slate-600 p-12 rounded-xl">
          <h2 className="text-2xl font-bold mb-4">อัปโหลดไฟล์นิยาย (.txt)</h2>
          <input type="file" accept=".txt" onChange={handleFileUpload} className="block w-full text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700" />
        </div>
      ) : (
        <div className="max-w-4xl mx-auto flex flex-col gap-6">
          <div className="flex justify-between items-center bg-slate-800 p-4 rounded-xl">
            <select value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)} className="bg-slate-700 p-2 rounded text-sm">
              {voices.map(v => (
                <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
              ))}
            </select>
            <button onClick={togglePlay} className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded font-bold">
              {isPlaying && !isPaused ? '⏸️ พัก' : '▶️ เล่น'}
            </button>
          </div>
          
          <div className="bg-slate-800 p-6 rounded-xl max-h-[60vh] overflow-y-auto leading-loose text-lg whitespace-pre-wrap">
            {displayChunks.map((chunk, i) => (
              <span key={i} className={i === currentIndex ? "bg-blue-600/50 text-white" : "text-slate-300"} onClick={() => { setCurrentIndex(i); if (isPlaying) speakChunk(i); }}>
                {chunk.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
