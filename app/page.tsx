import { LandingHero } from "@/components/landing/hero";
import { LandingFeatures } from "@/components/landing/features";
import { TerminalDemo } from "@/components/landing/terminal";
import Link from "next/link";
import { Metadata } from "next";
import { Github, Twitter } from "lucide-react";

export const metadata: Metadata = {
  title: "Zylos | Give your AI a life",
  description: "LLMs are geniuses — but they wake up with amnesia every session. Zylos gives them memory, communication, and autonomy. Open source, $20/month.",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20">
      <LandingHero />
      <LandingFeatures />
      <TerminalDemo />

      <footer className="py-12 border-t border-white/5 mt-0 bg-black/40">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-center text-sm text-muted-foreground gap-6">
            <div className="flex items-center gap-2">
              <span>Built by</span>
              <a href="https://coco.xyz" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-full hover:bg-white/10 hover:text-white transition-colors border border-white/5">
                <img src="/coco-logo.png" className="w-5 h-5 object-contain" alt="Coco" />
                <span className="font-semibold">Coco</span>
              </a>
            </div>

            <div className="flex items-center gap-6">
              <Link href="/privacy" className="hover:text-primary transition-colors">Privacy</Link>
              <Link href="/terms" className="hover:text-primary transition-colors">Terms</Link>
              <div className="h-4 w-px bg-white/10" />
              <a href="https://x.com/ZylosAI" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                <Twitter className="w-4 h-4" />
              </a>
              <a href="https://github.com/zylos-ai" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                <Github className="w-4 h-4" />
              </a>
            </div>
          </div>
          <div className="mt-8 text-center text-xs text-white/20">
            © 2026 Zylos AI. Open sourced under MIT License.
          </div>
        </div>
      </footer>
    </main>
  );
}
