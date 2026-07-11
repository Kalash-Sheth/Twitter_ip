import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Fastest IP — Live News Desk",
  description: "BSE corporate filings → editorial → X, in real time",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
