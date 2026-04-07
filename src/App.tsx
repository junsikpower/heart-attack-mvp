import React, { useState, useEffect, useRef } from 'react';
import { Heart, Send, Mic, User, Camera, AlertCircle } from 'lucide-react';
import { useCameraHeartRate, MeasurementStatus } from './hooks/useCameraHeartRate';

type Screen = 'lobby' | 'matching' | 'game';
type Mode = 'text' | 'voice' | null;

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('lobby');
  const [currentMode, setCurrentMode] = useState<Mode>(null);

  // 카메라 심박수 훅 (UI에 절대적으로 종속적이지 않은 독립적 상태 제공)
  const { bpm, status, waveform, error, stream, needsManualFlash, startMeasurement, confirmManualFlash } = useCameraHeartRate();

  const handleStart = (mode: Mode) => {
    // 만약 측정을 켜지 않고 시작을 누르면 그냥 넘기되 카메라 기반 기능을 못쓴다는 것을 인지 
    // 본 MVP에서는 로비에서 카메라 켜기를 유도합니다.
    setCurrentMode(mode);
    setCurrentScreen('matching');
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-red-500/30">
      {currentScreen === 'lobby' && (
        <LobbyScreen
          onStartText={() => handleStart('text')}
          onStartVoice={() => handleStart('voice')}
          startMeasurement={startMeasurement}
          status={status}
          bpm={bpm}
          error={error}
          stream={stream}
        />
      )}
      {currentScreen === 'matching' && (
        <MatchingScreen onMatchFound={() => setCurrentScreen('game')} />
      )}
      {currentScreen === 'game' && currentMode === 'text' && (
        <TextGameScreen bpm={bpm} status={status} waveform={waveform} startMeasurement={startMeasurement} />
      )}
      {currentScreen === 'game' && currentMode === 'voice' && (
        <VoiceGameScreen bpm={bpm} status={status} waveform={waveform} startMeasurement={startMeasurement} />
      )}

      {/* NATIVE_MIGRATION_NOTE: 네이티브 앱 제작 시, 하드웨어 플래시 제어가 보장되므로 이 모달(전체) 레이어는 삭제 가능합니다. */}
      {needsManualFlash && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center p-6">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 md:p-8 max-w-sm w-full flex flex-col items-center text-center shadow-[0_0_50px_rgba(239,68,68,0.2)]">
            <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-6 border-2 border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.3)]">
              <AlertCircle className="w-8 h-8 text-yellow-500" />
            </div>
            <h2 className="text-xl font-bold text-white mb-3">수동 조작 필요</h2>
            <p className="text-sm text-gray-400 mb-6 leading-relaxed">
              아이폰 등 일부 기기의 정책 상, 웹 브라우저가 <strong className="text-white">카메라 플래시</strong>를 자동으로 제어할 수 없습니다.<br/><br/>
              안정적인 심박 측정을 위해 지금 <strong>화면 상단을 쓸어내려 제어 센터에서 손전등(🔦)</strong>을 최대 밝기로 켜주세요.
            </p>
            <button
              onClick={confirmManualFlash}
              className="w-full py-4 bg-red-600 hover:bg-red-500 active:scale-95 transition-all text-white font-bold rounded-xl shadow-[0_4px_20px_rgba(220,38,38,0.4)]"
            >
              네, 손전등을 켰습니다
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// 공용: Waveform 모니터링 렌더러
// ==========================================
function WaveformCanvas({ data, status }: { data: number[], status: MeasurementStatus }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 초기화
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (status !== 'measuring' || data.length === 0) {
        ctx.fillStyle = '#374151'; // gray-700
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        let msg = '';
        if (status === 'initializing') msg = '카메라 로딩 중...';
        else if (status === 'no_finger') msg = '렌즈에 손가락을 덮으세요';
        else if (status === 'error') msg = '에러 발생';
        else msg = '안정화 대기중';
        ctx.fillText(msg, canvas.width / 2, canvas.height / 2 + 4);
        return;
    }

    const w = canvas.width;
    const h = canvas.height;
    
    // 데이터 보정(최소 최대 추출하여 화면에 꽉 차게 그림)
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = (max - min) || 1; 

    ctx.beginPath();
    ctx.strokeStyle = '#ef4444'; // 테일윈드 red-500
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    const step = w / (data.length - 1);
    
    for (let i = 0; i < data.length; i++) {
        // 정규화 (y축은 위가 0이므로 반전)
        const normalizedY = ((data[i] - min) / range);
        const y = h - (normalizedY * h * 0.8) - h * 0.1; // 위아래 10% 여백
        const x = i * step;
        
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    
    // 네온 효과
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(239, 68, 68, 0.5)';
    ctx.stroke();
    
    // 그림자 리셋
    ctx.shadowBlur = 0;
    
  }, [data, status]);

  return (
    <canvas 
      ref={canvasRef} 
      width={200} 
      height={60} 
      className="bg-gray-900 rounded-lg border border-gray-800"
    />
  );
}

// ==========================================
// 공용: Video Preview (스트림 연결용)
// ==========================================
function VideoPreview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return <video ref={videoRef} className="w-full h-full object-cover opacity-60" muted playsInline autoPlay />;
}

// ==========================================
// 화면 1: 게임 로비 (시작 화면)
// ==========================================
function LobbyScreen({
  onStartText,
  onStartVoice,
  startMeasurement,
  status,
  bpm,
  error,
  stream
}: {
  onStartText: () => void;
  onStartVoice: () => void;
  startMeasurement: () => void;
  status: MeasurementStatus;
  bpm: number | null;
  error: string | null;
  stream: MediaStream | null;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <div className="flex flex-col items-center space-y-8 w-full max-w-xs">

        {/* 로고 영역 */}
        <div className="flex flex-col items-center space-y-4">
          <Heart
            className="w-24 h-24 text-red-500 drop-shadow-[0_0_30px_rgba(239,68,68,0.8)] animate-pulse"
            fill="currentColor"
          />
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-widest text-transparent bg-clip-text bg-gradient-to-b from-red-400 to-red-700 drop-shadow-[0_0_15px_rgba(239,68,68,0.6)]">
            하트 어택
          </h1>
        </div>

        {/* 카메라 심박수 상태 UI */}
        <div className="w-full flex flex-col items-center space-y-4 p-4 bg-gray-900/50 border border-gray-800 rounded-2xl">
            {status === 'idle' || status === 'error' ? (
                <div className="w-full">
                    {error && (
                        <div className="flex items-center space-x-2 text-red-400 text-xs mb-3 bg-red-950/30 p-2 rounded">
                            <AlertCircle className="w-4 h-4 flex-shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}
                    <button
                        onClick={startMeasurement}
                        className="flex items-center justify-center space-x-3 w-full px-5 py-3 bg-gray-800 text-white font-bold rounded-xl hover:bg-gray-700 transition-all border border-gray-700"
                    >
                        <Camera className="w-5 h-5 text-red-400" />
                        <span>카메라 심박수 측정 켜기</span>
                    </button>
                    <p className="text-[11px] text-gray-500 text-center mt-2">
                        스마트폰 후면 카메라 렌즈를 손가락으로 가리고 시작하세요
                    </p>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center w-full space-y-3">
                    <div className="relative w-16 h-16 rounded-full overflow-hidden border-2 border-red-500 bg-gray-900 shadow-[0_0_15px_rgba(239,68,68,0.3)]">
                        {/* 카메라 미리보기 화면을 작게 띄워줘 손가락 위치를 확인시킴 */}
                        <VideoPreview stream={stream} />
                        {status === 'no_finger' && (
                            <div className="absolute inset-0 bg-red-900/80 flex items-center justify-center text-[10px] text-center font-bold">
                                렌즈<br/>덮기
                            </div>
                        )}
                    </div>
                    <div className="flex items-center space-x-2">
                        <Heart className="w-6 h-6 text-red-500 animate-pulse" fill="currentColor" />
                        <span className="text-3xl font-mono font-bold text-white">
                            {bpm !== null ? bpm : '--'}
                        </span>
                        <span className="text-sm font-bold text-red-500">BPM</span>
                    </div>
                    {status === 'initializing' && <span className="text-xs text-yellow-500">카메라 로딩중...</span>}
                </div>
            )}
        </div>

        {/* 시작 버튼 영역 */}
        <div className="flex flex-col space-y-3 w-full">
          <button
            onClick={onStartText}
            className="w-full px-8 py-4 text-lg font-bold text-white transition-all duration-300 border-2 border-red-600 rounded-full hover:bg-red-600 hover:shadow-[0_0_30px_rgba(239,68,68,0.7)] active:scale-95"
          >
            텍스트 멀티 플레이
          </button>

          <button
            onClick={onStartVoice}
            className="w-full flex items-center justify-center space-x-2 px-8 py-4 text-lg font-bold text-white transition-all duration-300 border-2 border-red-500/50 rounded-full hover:border-red-500 hover:bg-red-900/30 hover:shadow-[0_0_30px_rgba(239,68,68,0.4)] active:scale-95"
          >
            <Mic className="w-5 h-5" />
            <span>음성 멀티 플레이</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 화면 2: 매칭 중 화면 (공용)
// ==========================================
function MatchingScreen({ onMatchFound }: { onMatchFound: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onMatchFound();
    }, 2000); // 3초에서 2초로 줄임
    return () => clearTimeout(timer);
  }, [onMatchFound]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 space-y-10">
      <div className="relative flex items-center justify-center w-40 h-40">
        <div className="absolute inset-0 border-4 border-red-500 rounded-full opacity-20 animate-ping" style={{ animationDuration: '1.5s' }}></div>
        <div className="absolute inset-4 border-4 border-red-500 rounded-full opacity-40 animate-ping" style={{ animationDuration: '1.5s', animationDelay: '0.3s' }}></div>
        <Heart
          className="w-20 h-20 text-red-500 drop-shadow-[0_0_20px_rgba(239,68,68,0.8)] animate-bounce"
          fill="currentColor"
          style={{ animationDuration: '1s' }}
        />
      </div>
      <p className="text-xl md:text-2xl font-medium text-red-400 animate-pulse tracking-wide">
        심장이 뛰는 상대를 찾는 중...
      </p>
    </div>
  );
}

// ==========================================
// 공통 컴포넌트: 게임 상단 헤더 (심박수 표시 + 파형)
// ==========================================
function GameHeader({ bpm, status, waveform, startMeasurement }: { bpm: number | null; status: MeasurementStatus; waveform: number[]; startMeasurement: () => void }) {
  const isMeasuring = status === 'measuring';
  const showBpm = bpm !== null && isMeasuring;

  return (
    <header className="flex flex-col border-b border-red-900/40 bg-black/90 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center justify-between p-5 pb-3">
          {/* 내 심박수 영역 */}
          <div className="flex flex-col items-center w-28 relative">
            <span className="text-xs text-gray-400 mb-1 font-medium tracking-wider">MY BPM</span>
            
            {(status === 'idle' || status === 'error') ? (
               <button 
                 onClick={startMeasurement}
                 className="mt-1 px-3 py-1.5 bg-red-600 rounded whitespace-nowrap text-xs font-bold shadow-[0_0_10px_rgba(239,68,68,0.5)] hover:bg-red-500 active:scale-95"
               >
                  카메라 측정 켜기
               </button>
            ) : (
               <div className="flex items-center space-x-2">
                 <Heart
                   className="w-5 h-5 text-red-500 animate-pulse"
                   fill="currentColor"
                   style={{ animationDuration: showBpm ? `${60 / bpm}s` : '0.8s' }}
                 />
                 <span className={`text-3xl font-mono font-bold drop-shadow-[0_0_8px_rgba(255,255,255,0.5)] ${status === 'no_finger' ? 'text-red-500' : 'text-white'}`}>
                   {showBpm ? bpm : '--'}
                 </span>
               </div>
            )}
            
            {status === 'no_finger' && (
                <span className="absolute -bottom-4 text-[10px] text-red-500 whitespace-nowrap overflow-visible">손가락 덮으세요</span>
            )}
          </div>

          {/* VS 구분자 */}
          <div className="text-red-600/60 font-black text-2xl italic">VS</div>

          {/* 상대방 심박수 */}
          <div className="flex flex-col items-center w-24">
            <span className="text-xs text-gray-400 mb-1 font-medium tracking-wider">PARTNER</span>
            <div className="flex items-center space-x-2">
              <Heart className="w-5 h-5 text-red-500 animate-pulse" fill="currentColor" style={{ animationDuration: '1s' }} />
              <span className="text-3xl font-mono font-bold text-gray-500">---</span>
            </div>
          </div>
        </div>

        {/* 상단 파형 시각화 영역 */}
        <div className="flex justify-center pb-2">
           <WaveformCanvas data={waveform} status={status} />
        </div>
    </header>
  );
}

// ==========================================
// 화면 3-A: 본 게임 (텍스트 채팅) 화면
// ==========================================
function TextGameScreen({ bpm, status, waveform, startMeasurement }: { bpm: number | null; status: MeasurementStatus; waveform: number[]; startMeasurement: () => void }) {
  const [messages, setMessages] = useState<{ id: number; text: string; sender: 'me' | 'partner' }[]>([
    { id: 1, text: '안녕하세요! 직접 타이핑해서 공격해볼까요?', sender: 'partner' },
  ]);
  const [inputText, setInputText] = useState('');

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    setMessages(prev => [...prev, { id: Date.now(), text: inputText, sender: 'me' }]);
    setInputText('');
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto border-x border-gray-900 bg-black relative">
      <GameHeader bpm={bpm} status={status} waveform={waveform} startMeasurement={startMeasurement} />

      <main className="flex-1 p-4 overflow-y-auto space-y-4 scroll-smooth">
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] px-5 py-3 rounded-2xl text-base leading-relaxed ${
              msg.sender === 'me'
                ? 'bg-red-600 text-white rounded-tr-sm shadow-[0_4px_15px_rgba(220,38,38,0.3)]'
                : 'bg-gray-800 text-gray-100 rounded-tl-sm shadow-[0_4px_15px_rgba(0,0,0,0.5)]'
            }`}>
              {msg.text}
            </div>
          </div>
        ))}
      </main>

      <footer className="p-4 border-t border-gray-900 bg-black/95 pb-safe">
        <form onSubmit={handleSend} className="flex items-center space-x-3">
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="상대방의 심박수를 높여보세요..."
            className="flex-1 bg-gray-900 text-white px-5 py-4 rounded-full border border-gray-800 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all placeholder:text-gray-600"
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            className="p-4 bg-red-600 text-white rounded-full hover:bg-red-500 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(220,38,38,0.4)]"
          >
            <Send className="w-5 h-5 ml-1" />
          </button>
        </form>
      </footer>
    </div>
  );
}

// ==========================================
// 화면 3-B: 본 게임 (음성 대화) 화면
// ==========================================
function VoiceGameScreen({ bpm, status, waveform, startMeasurement }: { bpm: number | null; status: MeasurementStatus; waveform: number[]; startMeasurement: () => void }) {
  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto border-x border-gray-900 bg-black relative">
      <GameHeader bpm={bpm} status={status} waveform={waveform} startMeasurement={startMeasurement} />

      <main className="flex-1 flex flex-col">
        {/* 상대방 */}
        <div className="flex-1 flex flex-col items-center justify-center border-b border-gray-800/50 relative">
          <div className="w-32 h-32 bg-gray-800 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(0,0,0,0.5)] border-4 border-gray-700">
            <User className="w-16 h-16 text-gray-500" />
          </div>
          <span className="mt-4 text-gray-400 font-medium tracking-widest">PARTNER</span>
        </div>

        {/* 나 */}
        <div className="flex-1 flex flex-col items-center justify-center relative">
          <div className="w-32 h-32 bg-red-900/20 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(220,38,38,0.2)] border-4 border-red-800/50">
            <User className="w-16 h-16 text-red-500/80" />
          </div>
          <span className="mt-4 text-red-400 font-medium tracking-widest">ME</span>
        </div>
      </main>

      <footer className="p-8 border-t border-gray-900 bg-black/95 pb-safe flex flex-col items-center justify-center space-y-6">
        <style>{`
          @keyframes soundWave {
            0%, 100% { transform: scaleY(0.3); }
            50% { transform: scaleY(1); }
          }
          .sound-waveform-bar {
            animation: soundWave 1s ease-in-out infinite;
            transform-origin: bottom;
          }
        `}</style>

        <div className="flex items-end space-x-1.5 h-10">
          {[0.2, 0.5, 0.8, 0.3, 0.6, 0.9, 0.4, 0.7, 0.2].map((delay, i) => (
            <div
              key={i}
              className="w-1.5 bg-red-500 rounded-full sound-waveform-bar h-full"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </div>

        <div className="flex items-center space-x-2 text-red-400">
          <Mic className="w-5 h-5 animate-pulse" />
          <span className="font-medium tracking-wide">음성 대화 중... 카메라 위치를 유지해 주세요.</span>
        </div>
      </footer>
    </div>
  );
}
