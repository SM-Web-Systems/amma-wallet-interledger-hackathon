import { useState } from "react";

interface TokenIconProps {
  code?: string | null;
  image?: string | null;
  size?: number;
  className?: string;
}

export default function TokenIcon({
  code,
  image,
  size = 40,
  className = "",
}: TokenIconProps) {
  const [imgError, setImgError] = useState(false);
  const safeCode = code || "??";

  if (image && !imgError) {
    return (
      <div
        className={`rounded-full flex items-center justify-center bg-[#2a2f3a] shrink-0 ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={image}
          alt={safeCode}
          width={size * 0.75}
          height={size * 0.75}
          className="rounded-full object-contain"
          onError={() => setImgError(true)}
        />
      </div>
    );
  }

  const colors = [
    "bg-blue-700",
    "bg-purple-700",
    "bg-green-700",
    "bg-orange-700",
    "bg-pink-700",
    "bg-cyan-700",
  ];
  const colorIndex =
    safeCode.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) %
    colors.length;

  return (
    <div
      className={`${colors[colorIndex]} rounded-full flex items-center justify-center text-white font-bold shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {safeCode.slice(0, 2).toUpperCase()}
    </div>
  );
}