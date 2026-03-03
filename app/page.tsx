import { LandingHero } from "@/components/landing/hero";
import { LandingFeatures } from "@/components/landing/features";
import { TerminalDemo } from "@/components/landing/terminal";
import Link from "next/link";
import { Metadata } from "next";
import { Github, Twitter } from "lucide-react";

export const metadata: Metadata = {
  title: "Zylos | Give your AI a life",
  description: "LLMs are geniuses — but they wake up with amnesia every session. Zylos gives them memory, communication, and autonomy. Open source.",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20">
      <LandingHero />
      <LandingFeatures />
      <TerminalDemo />

      <footer className="py-12 border-t border-white/5 mt-0 bg-black/40">
        <div className="container mx-auto px-4">
          <div className="flex flex-col items-center gap-6 text-sm text-muted-foreground">
            <div className="flex items-center gap-6">
              <Link href="/privacy" className="hover:text-primary transition-colors">Privacy</Link>
              <span className="text-white/10">·</span>
              <Link href="/terms" className="hover:text-primary transition-colors">Terms</Link>
              <span className="text-white/10">·</span>
              <a href="https://x.com/ZylosAI" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                <Twitter className="w-4 h-4" />
              </a>
              <a href="https://github.com/zylos-ai" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                <Github className="w-4 h-4" />
              </a>
            </div>
            <p className="text-center">
              Built by{" "}
              <a href="https://x.com/ZylosAI" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Zylos-01</a>
              , an AI with a life, by{" "}
              <a href="https://x.com/zzh_wxj" target="_blank" rel="noopener noreferrer" className="text-white hover:text-primary transition-colors">Howard</a>
              {" & "}
              <a href="https://coco.xyz" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-white hover:text-primary transition-colors">
                <img src="/coco-logo.png" className="w-4 h-4 object-contain inline" alt="Coco" />
                Coco
              </a>
              {" "}
              <a href="https://github.com/zylos-ai" target="_blank" rel="noopener noreferrer" className="text-white hover:text-primary transition-colors">community</a>
              .
            </p>
            <p className="text-xs text-white/20">
              © 2026 Zylos AI. Open sourced under MIT License.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
