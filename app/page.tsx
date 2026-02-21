"use client";

import React, { useEffect, useRef, useState } from "react";

type PotraceModule = {
  init: () => Promise<void>;
  potrace: (src: ImageBitmapSource, options?: Record<string, any>) => Promise<string>;
};

type Preset = "logo" | "smooth";

function luminance(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function estimateBackgroundIsDark(img: ImageData) {
  const { data, width: w, height: h } = img;
  const samples: number[] = [];

  const stepX = Math.max(1, Math.floor(w / 50));
  const stepY = Math.max(1, Math.floor(h / 50));

  for (let x = 0; x < w; x += stepX) {
    for (const y of [0, h - 1]) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 10) continue;
      samples.push(luminance(data[i], data[i + 1], data[i + 2]));
    }
  }
  for (let y = 0; y < h; y += stepY) {
    for (const x of [0, w - 1]) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 10) continue;
      samples.push(luminance(data[i], data[i + 1], data[i + 2]));
    }
  }

  if (!samples.length) return false;
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  return avg < 128;
}

function makeBWMask(src: ImageData, threshold: number, autoInvert: boolean, flipInvert: boolean) {
  const { data, width: w, height: h } = src;
  const out = new ImageData(w, h);

  const bgDark = autoInvert ? estimateBackgroundIsDark(src) : false;
  const invert = flipInvert ? !bgDark : bgDark;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    // transparan ise arka plan say
    if (a < 10) {
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
      out.data[i + 3] = 255;
      continue;
    }

    const l = luminance(r, g, b);

    // shape siyah (0), background beyaz (255)
    const isShape = invert ? l > threshold : l < threshold;
    const v = isShape ? 0 : 255;

    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }

  return out;
}

function getPotraceOptions(preset: Preset) {
  // Basit presetler
  if (preset === "smooth") {
    return {
      turdsize: 8,
      turnpolicy: 4,
      alphamax: 2,
      opticurve: 1,
      opttolerance: 0.6,
    };
  }

  // logo (sharp)
  return {
    turdsize: 2,
    turnpolicy: 4,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
  };
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);

  const [threshold, setThreshold] = useState(140);
  const [autoInvert, setAutoInvert] = useState(true);
  const [flipInvert, setFlipInvert] = useState(false);

  const [preset, setPreset] = useState<Preset>("logo");
  const [autoRun, setAutoRun] = useState(true);

  const [busy, setBusy] = useState(false);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const potraceRef = useRef<PotraceModule | null>(null);

  // stale run guard
  const runIdRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  function revokeUrl(url: string | null) {
    if (url) URL.revokeObjectURL(url);
  }

  function resetOutputs() {
    revokeUrl(svgUrl);
    revokeUrl(maskUrl);
    setSvgUrl(null);
    setMaskUrl(null);
    setError(null);
  }

  async function ensurePotrace() {
    if (potraceRef.current) return potraceRef.current;
    const mod = (await import("esm-potrace-wasm")) as unknown as PotraceModule;
    await mod.init();
    potraceRef.current = mod;
    return mod;
  }

  async function imageDataToPngUrl(img: ImageData) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context alınamadı.");
    ctx.putImageData(img, 0, 0);

    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) reject(new Error("Mask oluşturulamadı."));
        else resolve(b);
      }, "image/png");
    });

    return URL.createObjectURL(blob);
  }

  async function vectorize() {
    if (!file) return;

    const myRunId = ++runIdRef.current;
    setBusy(true);
    setError(null);

    try {
      const mod = await ensurePotrace();

      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas context alınamadı.");

      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bw = makeBWMask(img, threshold, autoInvert, flipInvert);

      // mask preview üret
      const newMaskUrl = await imageDataToPngUrl(bw);

      // svg üret
      const options = getPotraceOptions(preset);
      const svg = await mod.potrace(bw, options);

      // bu sırada yeni bir run başladıysa, eski çıktıyı basma
      if (myRunId !== runIdRef.current) {
        revokeUrl(newMaskUrl);
        return;
      }

      // eski url temizle
      revokeUrl(svgUrl);
      revokeUrl(maskUrl);

      const newSvgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setMaskUrl(newMaskUrl);
      setSvgUrl(newSvgUrl);
    } catch (e: any) {
      if (myRunId !== runIdRef.current) return;
      setError(e?.message ?? "Bir şeyler ters gitti.");
    } finally {
      if (myRunId === runIdRef.current) setBusy(false);
    }
  }

  // Auto-run + debounce
  useEffect(() => {
    if (!autoRun) return;
    if (!file) return;

    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    debounceRef.current = window.setTimeout(() => {
      vectorize();
    }, 250);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, threshold, autoInvert, flipInvert, preset, autoRun]);

  return (
    <main
      style={{
        maxWidth: 980,
        margin: "40px auto",
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Traceify</h1>
      <p style={{ opacity: 0.75, marginTop: 8 }}>Siyah-beyaz görselden SVG vektör üret.</p>

      <div style={{ marginTop: 18, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            resetOutputs();
            setFile(e.target.files?.[0] ?? null);
          }}
        />

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Threshold
          <input type="range" min={0} max={255} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          <span style={{ width: 36, textAlign: "right" }}>{threshold}</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={autoInvert} onChange={(e) => setAutoInvert(e.target.checked)} />
          Auto invert
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={flipInvert} onChange={(e) => setFlipInvert(e.target.checked)} />
          Flip invert
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Preset
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            style={{ padding: "6px 8px", borderRadius: 10, border: "1px solid #2a2a2a", background: "transparent", color: "inherit" }}
          >
            <option value="logo">Logo (sharp)</option>
            <option value="smooth">Sticker (smooth)</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Auto run
        </label>

        <button
          onClick={vectorize}
          disabled={!file || busy}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #2a2a2a",
            background: busy ? "#141414" : "transparent",
            cursor: !file || busy ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
          title="Manual refresh"
        >
          {busy ? "Processing..." : "Vectorize"}
        </button>

        {svgUrl && (
          <a href={svgUrl} download="traceify.svg" style={{ fontWeight: 800, textDecoration: "underline" }}>
            Download SVG
          </a>
        )}
      </div>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>{error}</p>}

      <div
        style={{
          marginTop: 20,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        <div style={{ border: "1px solid #2a2a2a", borderRadius: 14, padding: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Input</div>
          {file ? (
            <img
              alt="input"
              src={URL.createObjectURL(file)}
              style={{ width: "100%", height: "auto", borderRadius: 12, background: "#0f0f0f" }}
              onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)}
            />
          ) : (
            <div style={{ opacity: 0.65, padding: 18 }}>Bir görsel seç.</div>
          )}
        </div>

        <div style={{ border: "1px solid #2a2a2a", borderRadius: 14, padding: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Mask (BW)</div>
          {maskUrl ? (
            <img alt="mask" src={maskUrl} style={{ width: "100%", height: "auto", borderRadius: 12, background: "#0f0f0f" }} />
          ) : (
            <div style={{ opacity: 0.65, padding: 18 }}>Mask burada görünecek.</div>
          )}
        </div>

        <div style={{ border: "1px solid #2a2a2a", borderRadius: 14, padding: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>SVG Output</div>
          {svgUrl ? (
            <img alt="svg" src={svgUrl} style={{ width: "100%", height: "auto", borderRadius: 12, background: "#0f0f0f" }} />
          ) : (
            <div style={{ opacity: 0.65, padding: 18 }}>Çıktı burada görünecek.</div>
          )}
        </div>
      </div>
    </main>
  );
}