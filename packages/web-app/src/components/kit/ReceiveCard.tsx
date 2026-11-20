import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Share2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { FieldError } from "./FieldError";

export interface ReceiveCardLabels {
  yourAddress: string;
  copyAddress: string;
  copied: string;
  copyFailed: string;
  share: string;
  downloadQr: string;
  qrTitle: string;
  memoOrTag?: string;
}

/**
 * The receive card every chain shares: a QR code, the address with a copy button, and share and download actions.
 * It takes plain props and every visible word as `labels`, so each page keeps its own wording and translations.
 * `children` shows under the QR code (a token and amount line, for example). `qrValue` defaults to the address
 * and can be a payment link. Nothing here knows which chain it is: `network` is only a label.
 */
export function ReceiveCard({
  address,
  qrValue,
  network,
  memoOrTag,
  labels,
  qrId = "receive-qr",
  qrImage,
  downloadName = "receive-qr",
  children,
}: {
  address: string;
  qrValue?: string;
  network?: string;
  memoOrTag?: { label: string; value: string };
  labels: ReceiveCardLabels;
  qrId?: string;
  qrImage?: string | null;
  downloadName?: string;
  children?: ReactNode;
}) {
  const errorId = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopyFailed(false);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopyFailed(false), 6000);
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: network ?? labels.yourAddress, text: address });
    } catch {
      /* the person closed the share sheet, or this device cannot share: the address stays on screen to copy */
    }
  };

  const download = () => {
    const svg = document.getElementById(qrId);
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const a = document.createElement("a");
      a.download = `${downloadName}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  };

  const actionClass = "flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-stellar-muted transition-colors hover:bg-stellar-hover hover:text-stellar-text";

  return (
    <div className="space-y-4">
      <div className="bg-stellar-card border border-stellar-border rounded-2xl p-8 flex flex-col items-center">
        {network && <p className="mb-4 text-xs font-medium text-stellar-muted">{network}</p>}
        <div className="bg-white rounded-xl p-4">
          <QRCodeSVG
            id={qrId}
            title={labels.qrTitle}
            value={qrValue || address}
            size={220}
            level="M"
            imageSettings={qrImage ? { src: qrImage, width: 40, height: 40, excavate: true } : undefined}
          />
        </div>
        {children}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={download} className={actionClass}>
            <Download size={16} aria-hidden="true" />{labels.downloadQr}
          </button>
          {canShare && (
            <button type="button" onClick={share} className={actionClass}>
              <Share2 size={16} aria-hidden="true" />{labels.share}
            </button>
          )}
        </div>
      </div>

      <div className="bg-stellar-card border border-stellar-border rounded-xl p-4">
        <p className="block text-xs text-stellar-muted mb-2">{labels.yourAddress}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm text-stellar-text font-mono break-all">{address}</code>
          <button
            type="button"
            onClick={copy}
            aria-label={labels.copyAddress}
            className="shrink-0 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-stellar-hover transition-colors"
          >
            {copied ? <Check size={18} className="text-stellar-success-text" aria-hidden="true" /> : <Copy size={18} className="text-stellar-muted" aria-hidden="true" />}
          </button>
        </div>
        <p role="status" className="sr-only">{copied ? labels.copied : ""}</p>
        <FieldError id={errorId}>{copyFailed ? labels.copyFailed : null}</FieldError>
      </div>

      {memoOrTag && (
        <div className="bg-stellar-card border border-stellar-border rounded-xl p-4">
          <p className="block text-xs text-stellar-muted mb-2">{memoOrTag.label}</p>
          <code className="text-sm text-stellar-text font-mono break-all">{memoOrTag.value}</code>
        </div>
      )}
    </div>
  );
}
