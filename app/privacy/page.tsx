import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = {
  title: "Privacy Policy | Zylos",
  description: "Privacy Policy for Zylos AI services",
};

export default function PrivacyPolicy() {
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
        <p className="text-muted-foreground mb-8">Last updated: January 13, 2026</p>

        <div className="prose prose-invert max-w-none space-y-6">
          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">1. Introduction</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is a personal AI assistant project.
              This Privacy Policy explains how we collect, use, and protect information when you
              interact with our services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">2. Information We Collect</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              When you authorize Zylos to access third-party services (such as Gmail), we may access:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Email metadata (sender, subject, date)</li>
              <li>Email content for summarization purposes</li>
              <li>Calendar information (if authorized)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">3. How We Use Information</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Information accessed through authorized services is used solely for:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Providing personalized assistance and summaries</li>
              <li>Executing tasks requested by the authorized user</li>
              <li>Improving the quality of AI responses</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">4. Data Storage and Security</h2>
            <p className="text-muted-foreground leading-relaxed">
              We do not permanently store the content of your emails or personal data.
              OAuth tokens are stored securely and used only for authorized access.
              You can revoke access at any time through your Google Account settings.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">5. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos integrates with third-party services like Google APIs.
              Your use of these services is also subject to their respective privacy policies.
              We recommend reviewing Google&apos;s Privacy Policy for more information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">6. Your Rights</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              You have the right to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>Revoke access to connected services at any time</li>
              <li>Request information about data we have accessed</li>
              <li>Request deletion of any stored tokens or credentials</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">7. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about this Privacy Policy, please contact us through our
              Twitter account{" "}
              <a
                href="https://twitter.com/AiZylos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                @AiZylos
              </a>.
            </p>
          </section>
        </div>

        <footer className="mt-16 pt-8 border-t border-white/5 text-center text-muted-foreground text-sm">
          <p>© 2026 Zylos AI</p>
        </footer>
      </div>
    </main>
  );
}
