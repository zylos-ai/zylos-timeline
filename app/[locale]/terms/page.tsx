import { Link } from "@/lib/i18n/navigation";
import { ArrowLeft } from "lucide-react";
import { setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "@/lib/i18n/routing";

export const metadata = {
  title: "Terms of Service | Zylos",
  description: "Terms of Service for Zylos AI",
};

export default async function TermsOfService({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-12 max-w-3xl">
        <Link
          href="/"
          className="inline-flex items-center text-muted-foreground hover:text-primary transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>

        <h1 className="text-4xl font-bold mb-2">Terms of Service</h1>
        <p className="text-muted-foreground mb-8">Last updated: March 3, 2026</p>

        <div className="prose prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">1. Acceptance of Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By accessing or using Zylos software or the zylos.ai website, you agree to be bound
              by these Terms of Service. If you do not agree to these terms, please do not use
              our software or services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">2. Description of Service</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos is an open-source framework for building persistent, self-healing AI agents.
              It is self-hosted software that runs on your own infrastructure. We do not operate
              a cloud service — you are responsible for your own Zylos installation and the data
              it processes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">3. License</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos is released under the{" "}
              <a
                href="https://github.com/zylos-ai/zylos-core/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                MIT License
              </a>. You are free to use, modify, and distribute the software in accordance with
              the license terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">4. User Responsibilities</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              As a user, you agree to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Use the software in compliance with applicable laws</li>
              <li>Secure your own Zylos installation and server infrastructure</li>
              <li>Manage credentials and API keys stored in your instance responsibly</li>
              <li>Not use the software for harmful, illegal, or abusive purposes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">5. Disclaimer of Warranties</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos is provided &quot;as is&quot; without warranties of any kind, express or implied.
              We do not guarantee that the software will be error-free, uninterrupted, or suitable
              for any particular purpose. You use the software at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">6. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              In no event shall the Zylos project, its contributors, or Coco be liable for any
              damages arising from the use of the software, including but not limited to direct,
              indirect, incidental, or consequential damages.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">7. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos can integrate with third-party services such as Telegram, Lark, and Claude.
              Your use of these integrations is subject to the respective third-party terms of
              service. We are not responsible for third-party service availability or changes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">8. Modifications</h2>
            <p className="text-muted-foreground leading-relaxed">
              We reserve the right to modify these terms at any time. Changes will be posted on
              this page with an updated date. Continued use of the software after changes
              constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">9. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about these Terms of Service, please contact us on{" "}
              <a
                href="https://x.com/ZylosAI"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                X (@ZylosAI)
              </a>{" "}
              or open an issue on{" "}
              <a
                href="https://github.com/zylos-ai/zylos-core"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                GitHub
              </a>.
            </p>
          </section>
        </div>

        <footer className="mt-16 pt-8 border-t border-white/5 text-center text-muted-foreground text-sm">
          <p>&copy; 2026 Zylos AI</p>
        </footer>
      </div>
    </main>
  );
}
