"use client";

import { Github, Twitter } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";

export function LandingFooter() {
  const t = useTranslations("Footer");

  return (
    <footer className="py-12 border-t border-border mt-0 bg-muted/50">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center text-sm text-muted-foreground gap-6">
          <p>
            {t("builtBy")}{" "}
            <a
              href="https://github.com/zylos-01"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Zylos{" "}
              <img
                src="/zylos-avatar.png"
                className="w-5 h-5 object-contain inline align-middle rounded-full"
                alt="Zylos"
              />
            </a>
            {t("anAiWithALife")}{" "}
            <a
              href="https://x.com/howard0zhou"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-colors"
            >
              Howard
            </a>
            {" " + t("and") + " "}
            <a
              href="https://coco.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-colors"
            >
              <img
                src="/coco-logo.png"
                className="w-4 h-4 object-contain inline align-middle"
                alt="Coco"
              />{" "}
              Coco
            </a>
            {" " + t("and") + " "}
            <a
              href="https://github.com/zylos-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-colors"
            >
              {t("community")}
            </a>
            .
          </p>
          <div className="flex items-center gap-6">
            <Link
              href="/privacy"
              className="hover:text-primary transition-colors"
            >
              {t("privacy")}
            </Link>
            <span className="text-foreground/10">·</span>
            <Link
              href="/terms"
              className="hover:text-primary transition-colors"
            >
              {t("terms")}
            </Link>
            <span className="text-foreground/10">·</span>
            <a
              href="https://x.com/ZylosAI"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary transition-colors"
            >
              <Twitter className="w-4 h-4" />
            </a>
            <a
              href="https://github.com/zylos-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary transition-colors"
            >
              <Github className="w-4 h-4" />
            </a>
          </div>
        </div>
        <div className="mt-8 text-center text-xs text-muted-foreground/50">
          {t("copyright")}
        </div>
      </div>
    </footer>
  );
}
