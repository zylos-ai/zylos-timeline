"use client";

import { motion } from "framer-motion";
import { Brain, Activity, Network, Terminal, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";

type FeatureKey = "oneConsciousness" | "contextGuaranteed" | "selfHealing" | "bestInClass" | "openClaw";

const featureConfigs: { key: FeatureKey; icon: LucideIcon; className: string }[] = [
    { key: "oneConsciousness", icon: Network, className: "" },
    { key: "contextGuaranteed", icon: Brain, className: "" },
    { key: "selfHealing", icon: Activity, className: "" },
    { key: "bestInClass", icon: Terminal, className: "" },
    { key: "openClaw", icon: Puzzle, className: "md:col-span-2" },
];

export function LandingFeatures() {
    const t = useTranslations("Features");

    return (
        <section id="features" className="py-24 bg-muted/50 relative border-t border-border">
            <div className="container mx-auto px-4">

                <div className="mb-16">
                    <h2 className="text-3xl md:text-4xl font-bold mb-4">{t("heading")}</h2>
                    <p className="text-muted-foreground max-w-2xl text-lg">
                        {t("subheading")}
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-[minmax(180px,auto)]">
                    {featureConfigs.map((feature, i) => {
                        const Icon = feature.icon;
                        return (
                            <motion.div
                                key={feature.key}
                                initial={{ opacity: 0, y: 20 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: i * 0.1 }}
                                className={cn(
                                    "group relative overflow-hidden rounded-3xl border border-border bg-card p-8 hover:bg-accent transition-colors",
                                    feature.className
                                )}
                            >
                                <div className="absolute top-0 right-0 p-8 opacity-20 group-hover:opacity-40 transition-opacity">
                                    <Icon className="w-24 h-24 -mr-8 -mt-8" />
                                </div>

                                <div className="relative z-10 flex flex-col h-full justify-between">
                                    <div>
                                        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center mb-4 text-primary">
                                            <Icon className="w-5 h-5" />
                                        </div>
                                        <h3 className="text-xl font-bold mb-2 text-foreground">{t(`${feature.key}.title`)}</h3>
                                        <p className="text-muted-foreground leading-relaxed">{t(`${feature.key}.description`)}</p>
                                    </div>
                                </div>
                            </motion.div>
                        );
                    })}
                </div>

            </div>
        </section>
    );
}
