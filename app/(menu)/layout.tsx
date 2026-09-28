import { MenuShell } from "../MenuShell";

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  return <MenuShell>{children}</MenuShell>;
}
