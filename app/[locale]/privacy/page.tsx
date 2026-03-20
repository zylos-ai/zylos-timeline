import { Link } from "@/lib/i18n/navigation";
import { ArrowLeft } from "lucide-react";
import { setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "@/lib/i18n/routing";

export const metadata = {
  title: "Privacy Policy | Zylos",
  description: "Privacy Policy for Zylos AI",
};

export default async function PrivacyPolicy({
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

        <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-muted-foreground mb-8">Last updated: March 3, 2026</p>

        <div className="prose prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">1. Introduction</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is an open-source framework
              for building persistent, self-healing AI agents. This Privacy Policy explains how we
              handle information in relation to the Zylos software and the zylos.ai website.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">2. Self-Hosted Software</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos is self-hosted software that runs entirely on your own infrastructure. When you
              install and use Zylos, all data — including memory, conversations, credentials, and
              configuration — stays on your server. We do not operate a cloud service and have no
              access to your Zylos instance or its data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">3. Website Data Collection</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The zylos.ai website is a static informational site. We collect minimal data:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Standard web server logs (IP address, browser type, pages visited)</li>
              <li>No cookies, no tracking pixels, no analytics services</li>
              <li>No user accounts or personal information collection</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">4. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos can be configured to connect to third-party services (Telegram, Lark, etc.)
              by the user who operates the instance. These connections are configured and controlled
              entirely by you. We recommend reviewing the privacy policies of any third-party
              services you choose to integrate.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">5. Data Sharing</h2>
            <p className="text-muted-foreground leading-relaxed">
              We do not collect, sell, trade, or share any user data. Since Zylos is self-hosted,
              your data never passes through our servers.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">6. Open Source</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos is open source under the MIT License. You can inspect the complete source code
              on{" "}
              <a
                href="https://github.com/zylos-ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                GitHub
              </a>{" "}
              to verify our privacy practices.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">7. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about this Privacy Policy, please contact us on{" "}
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
