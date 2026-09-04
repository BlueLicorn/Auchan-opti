import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Auchan-Opti — courses et repas sous budget",
  description:
    "Génère une liste de courses et les recettes correspondantes à partir d'un budget, d'un nombre de repas et de tes contraintes de cuisine.",
};

export const viewport: Viewport = {
  themeColor: "#f7f5f2",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
