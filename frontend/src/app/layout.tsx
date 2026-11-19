import type { Metadata } from "next";
import "../app.css";

export const metadata: Metadata = {
  title: "YieldPilot",
  description: "Predict how many admitted students will enroll, in seven guided steps. Built for university enrollment teams.",
  applicationName: "YieldPilot",
  openGraph: { title: "YieldPilot", description: "Predict how many admitted students will enroll, in seven guided steps.", type: "website" },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
