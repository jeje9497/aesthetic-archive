import { useEffect, useRef, useState } from "react";

const LERP_FACTOR = 0.22;
const OPENNESS_SMOOTH = 0.55;

const MP_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js",
  "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js",
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js",
];

const HAND_CONNECTIONS_FALLBACK = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const dist = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

// frame 0 = 만개, end frame = 봉오리 → openness=1 → currentTime=0
const mapOpennessToTime = (openness, duration) =>
  Math.max(0, Math.min(duration - 0.02, (1 - openness) * (duration - 0.02)));

const computeOpenness = (lm) => {
  const wrist = lm[0];
  const pairs = [
    [8, 5],
    [12, 9],
    [16, 13],
    [20, 17],
  ];
  let sum = 0;
  let n = 0;
  for (const [tip, mcp] of pairs) {
    const tipDist = dist(lm[tip], wrist);
    const mcpDist = dist(lm[mcp], wrist);
    if (mcpDist < 1e-6) continue;
    const ratio = tipDist / mcpDist;
    sum += clamp((ratio - 1.0) / 1.0, 0, 1);
    n++;
  }
  const thumbRatio = dist(lm[4], wrist) / Math.max(1e-6, dist(lm[2], wrist));
  sum += clamp((thumbRatio - 1.0) / 1.0, 0, 1) * 0.6;
  n += 0.6;
  return n > 0 ? sum / n : 0;
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-mp="${src}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.crossOrigin = "anonymous";
    el.dataset.mp = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

export default function FlowerHandControl() {
  const flowerRef = useRef(null);
  const webcamRef = useRef(null);
  const overlayRef = useRef(null);

  const targetTimeRef = useRef(null);
  const opennessSmoothedRef = useRef(0);
  const lerpRafRef = useRef(null);
  const handVisibleRef = useRef(false);

  const [status, setStatus] = useState({ label: "대기", openness: 0 });
  const [needPermission, setNeedPermission] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    let mounted = true;
    let camera = null;
    let hands = null;
    let stream = null;

    const drawHand = (lm) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const ctx = overlay.getContext("2d");
      const w = overlay.width;
      const h = overlay.height;
      const connections =
        (typeof window.HAND_CONNECTIONS !== "undefined" && window.HAND_CONNECTIONS) ||
        HAND_CONNECTIONS_FALLBACK;
      if (
        typeof window.drawConnectors === "function" &&
        typeof window.drawLandmarks === "function"
      ) {
        window.drawConnectors(ctx, lm, connections, { color: "#7CFFB2", lineWidth: 2 });
        window.drawLandmarks(ctx, lm, { color: "#FF7C7C", lineWidth: 1, radius: 2 });
        return;
      }
      ctx.strokeStyle = "#7CFFB2";
      ctx.lineWidth = 2;
      for (const [a, b] of connections) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
        ctx.stroke();
      }
      ctx.fillStyle = "#FF7C7C";
      for (const pt of lm) {
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    const onResults = (results) => {
      const overlay = overlayRef.current;
      if (overlay) {
        const ctx = overlay.getContext("2d");
        ctx.clearRect(0, 0, overlay.width, overlay.height);
      }
      const flower = flowerRef.current;

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        handVisibleRef.current = false;
        opennessSmoothedRef.current = opennessSmoothedRef.current * OPENNESS_SMOOTH;
        if (flower && isFinite(flower.duration) && flower.duration > 0) {
          targetTimeRef.current = mapOpennessToTime(
            opennessSmoothedRef.current,
            flower.duration
          );
        }
        setStatus({ label: "대기", openness: 0 });
        return;
      }

      handVisibleRef.current = true;
      const landmarks = results.multiHandLandmarks[0];
      drawHand(landmarks);

      const raw = computeOpenness(landmarks);
      opennessSmoothedRef.current =
        opennessSmoothedRef.current * OPENNESS_SMOOTH + raw * (1 - OPENNESS_SMOOTH);
      const openness = opennessSmoothedRef.current;

      if (flower && isFinite(flower.duration) && flower.duration > 0) {
        targetTimeRef.current = mapOpennessToTime(openness, flower.duration);
      }

      const pct = Math.round(openness * 100);
      let label;
      if (pct >= 75) label = "꽃 피우기";
      else if (pct <= 25) label = "꽃 지우기";
      else label = "중간";
      setStatus({ label, openness });
    };

    const lerpStep = () => {
      const flower = flowerRef.current;
      if (flower && isFinite(flower.duration) && flower.duration > 0) {
        const fallback = flower.duration - 0.02;
        const target = targetTimeRef.current != null ? targetTimeRef.current : fallback;
        const cur = flower.currentTime;
        const diff = target - cur;
        if (Math.abs(diff) > 0.003) {
          const next = cur + diff * LERP_FACTOR;
          flower.currentTime = clamp(next, 0, flower.duration - 0.01);
        } else if (Math.abs(diff) > 0) {
          flower.currentTime = clamp(target, 0, flower.duration - 0.01);
        }
      }
      lerpRafRef.current = requestAnimationFrame(lerpStep);
    };

    const initVideo = () => {
      const flower = flowerRef.current;
      if (!flower) return;
      flower.pause();
      lerpRafRef.current = requestAnimationFrame(lerpStep);
    };

    const init = async () => {
      try {
        for (const src of MP_SCRIPTS) await loadScript(src);
      } catch (e) {
        if (!mounted) return;
        setErrorMsg(
          "MediaPipe 라이브러리를 불러오지 못했습니다. 네트워크 상태를 확인하고 새로고침해주세요."
        );
        return;
      }
      if (!mounted) return;

      if (typeof window.Hands === "undefined" || typeof window.Camera === "undefined") {
        setErrorMsg("MediaPipe 초기화에 실패했습니다. 페이지를 새로고침해주세요.");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false,
        });
      } catch (err) {
        if (!mounted) return;
        setErrorMsg(
          "카메라 접근이 거부되었습니다. 브라우저 주소창의 자물쇠 아이콘에서 카메라 권한을 허용해주세요."
        );
        return;
      }
      if (!mounted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const webcam = webcamRef.current;
      const overlay = overlayRef.current;
      if (!webcam || !overlay) return;

      webcam.srcObject = stream;
      await new Promise((res) => {
        webcam.onloadedmetadata = () => {
          webcam.play();
          overlay.width = webcam.videoWidth;
          overlay.height = webcam.videoHeight;
          res();
        };
      });

      if (!mounted) return;
      setNeedPermission(false);

      hands = new window.Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
        selfieMode: true,
      });
      hands.onResults(onResults);

      camera = new window.Camera(webcam, {
        onFrame: async () => {
          if (hands) await hands.send({ image: webcam });
        },
        width: 640,
        height: 480,
      });
      camera.start();
    };

    initVideo();
    init();

    return () => {
      mounted = false;
      if (lerpRafRef.current) cancelAnimationFrame(lerpRafRef.current);
      try { camera && camera.stop(); } catch (e) {}
      try { hands && hands.close(); } catch (e) {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const pct = Math.round(status.openness * 100);

  return (
    <div className="relative h-screen w-full bg-black overflow-hidden text-white font-sans">
      <video
        ref={flowerRef}
        src="flower1_intra.mp4"
        muted
        playsInline
        preload="auto"
        className="absolute inset-0 h-screen w-full object-cover bg-black"
      />

      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2 text-[13px] tracking-wide text-white/85 bg-white/[0.06] border border-white/10 rounded-full backdrop-blur-md select-none pointer-events-none">
        ✋ 손을 펴면 꽃이 핍니다 &nbsp;·&nbsp; ✊ 주먹을 쥐면 꽃이 집니다
      </div>

      <div className="fixed right-4 bottom-4 w-[220px] z-10 select-none">
        <div className="relative w-full h-[165px] bg-black overflow-hidden rounded-md border border-white/10">
          <video
            ref={webcamRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover [transform:scaleX(-1)]"
          />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 w-full h-full pointer-events-none [transform:scaleX(-1)]"
          />
        </div>
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-white/50">상태</span>
            <span
              className={
                "px-2 py-0.5 rounded-full border " +
                (status.label === "꽃 피우기"
                  ? "border-emerald-400/40 text-emerald-300"
                  : status.label === "꽃 지우기"
                  ? "border-rose-400/40 text-rose-300"
                  : status.label === "중간"
                  ? "border-amber-300/40 text-amber-200"
                  : "border-white/20 text-white/70")
              }
            >
              {status.label}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-white/50">
            <span>펼침</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-white/70 transition-[width] duration-100"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      {needPermission && !errorMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm">
          <div className="max-w-md text-center px-6">
            <div className="text-xl font-semibold mb-2">웹캠 권한이 필요합니다</div>
            <div className="text-sm opacity-75 leading-relaxed">
              손동작으로 영상을 제어하기 위해 카메라를 사용합니다.<br />
              브라우저 상단에서 카메라 접근을 허용해주세요.
            </div>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 text-center px-6">
          <div className="max-w-md">
            <div className="text-xl font-semibold mb-2">불러오기 실패</div>
            <div className="text-sm opacity-75 leading-relaxed">{errorMsg}</div>
          </div>
        </div>
      )}
    </div>
  );
}
