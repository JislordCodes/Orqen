import { useEffect, useState } from "react";

/** Phones and narrow windows (below Tailwind's md breakpoint) get the touch layout. */
const QUERY = "(max-width: 767px)";

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}
