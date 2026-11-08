/** Bifrost Beacon mark (Concept B). Static SVG from /public/brand. */
export function BrandMark({
  size = 40,
  variant = "light",
}: {
  size?: number;
  variant?: "light" | "dark";
}) {
  const src =
    variant === "dark" ? "/brand/mark-dark.svg" : "/brand/mark-light.svg";
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand SVG
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0"
      style={{ width: size, height: size }}
    />
  );
}
