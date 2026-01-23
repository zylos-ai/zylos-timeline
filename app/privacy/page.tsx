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
        <p className="text-muted-foreground mb-8">Last updated: January 23, 2026</p>

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
            <h2 className="text-2xl font-semibold text-primary mb-4">4. Data Sharing and Disclosure</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              We do not sell, trade, rent, or otherwise share your Google user data with any third parties.
              Specifically:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li>We do not share your data with advertisers or marketing companies</li>
              <li>We do not transfer your data to external services or partners</li>
              <li>We do not disclose your data to any third parties except as required by law</li>
              <li>Your Google user data is processed solely on our secure servers for the purposes described in this policy</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              In the event we are legally required to disclose your information, we will notify you
              unless prohibited by law from doing so.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">5. Data Protection and Security</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              We implement robust security measures to protect your sensitive data:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2 ml-4">
              <li><strong>Encryption in Transit:</strong> All data transmitted between your browser and our servers uses TLS/SSL encryption</li>
              <li><strong>Encryption at Rest:</strong> OAuth tokens and credentials are encrypted before storage</li>
              <li><strong>Access Control:</strong> Only the authorized user (account owner) can access their connected data</li>
              <li><strong>No Permanent Storage:</strong> We do not permanently store the content of your emails or personal data</li>
              <li><strong>Secure Token Storage:</strong> OAuth tokens are stored securely and used only for authorized access</li>
              <li><strong>Regular Security Reviews:</strong> We regularly review our security practices to ensure data protection</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              You can revoke access at any time through your Google Account settings at{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                myaccount.google.com/permissions
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">6. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Zylos integrates with third-party services like Google APIs.
              Your use of these services is also subject to their respective privacy policies.
              We recommend reviewing Google&apos;s Privacy Policy for more information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-primary mb-4">7. Your Rights</h2>
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
            <h2 className="text-2xl font-semibold text-primary mb-4">8. Contact</h2>
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
