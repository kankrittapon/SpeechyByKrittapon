import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Black Desert Audio Reader",
  description: "อ่านนิยายและบันทึกการผจญภัยด้วยเสียง พร้อมธีมแฟนตาซีเข้ม",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
