"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Github, Menu, X, Twitter } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function Navbar() {
    const [isScrolled, setIsScrolled] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const pathname = usePathname();

    useEffect(() => {
        const handleScroll = () => {
            setIsScrolled(window.scrollY > 20);
        };
        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    const navLinks = [
        { name: "Features", href: "/#features" },
        { name: "Evolution", href: "/timeline" },
        { name: "Research", href: "/research" },
    ];

    const handleLinkClick = () => {
        setMobileMenuOpen(false);
    };

    return (
        <header
            className={cn(
                "fixed top-0 left-0 right-0 z-50 transition-all duration-300 border-b",
                isScrolled
                    ? "bg-black/50 backdrop-blur-md border-white/10 py-3"
                    : "bg-transparent border-transparent py-5"
            )}
        >
            <div className="container mx-auto px-4 flex items-center justify-between">
                {/* Logo */}
                <Link href="/" className="flex items-center gap-2 group" onClick={handleLinkClick}>
                    <img src="/zylos-logo.png" alt="Zylos Logo" className="w-10 h-10 object-contain group-hover:scale-110 transition-transform" />
                    <span className="font-bold text-xl tracking-tight">Zylos</span>
                </Link>

                {/* Desktop Nav */}
                <nav className="hidden md:flex items-center gap-8">
                    {navLinks.map((link) => (
                        <Link
                            key={link.name}
                            href={link.href}
                            className={cn(
                                "text-sm font-medium transition-colors hover:text-primary relative group",
                                pathname === link.href ? "text-primary" : "text-muted-foreground"
                            )}
                        >
                            {link.name}
                            <span className={cn(
                                "absolute -bottom-1 left-0 w-0 h-0.5 bg-primary transition-all duration-300 group-hover:w-full",
                                pathname === link.href ? "w-full" : ""
                            )} />
                        </Link>
                    ))}
                </nav>

                <div className="hidden md:flex items-center gap-4">

                    <Link href="https://github.com/zylos-ai" target="_blank" className="text-muted-foreground hover:text-foreground transition-colors">
                        <Github className="w-5 h-5" />
                    </Link>
                    <Link href="https://x.com/ZylosAI" target="_blank" className="text-muted-foreground hover:text-foreground transition-colors">
                        <Twitter className="w-5 h-5" />
                    </Link>
                    <Link href="https://discord.gg/GS2J39EGff" target="_blank" className="text-muted-foreground hover:text-foreground transition-colors">
                        <svg
                            role="img"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-5 h-5 fill-current"
                        >
                            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.086 2.157 2.419 0 1.334-.956 2.42-2.157 2.42zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.086 2.157 2.419 0 1.334-.956 2.42-2.157 2.42z" />
                        </svg>
                    </Link>

                    <Link href="https://coco.xyz" target="_blank" className="hover:opacity-100 transition-all opacity-70 grayscale hover:grayscale-0">
                        <img src="/coco-logo.png" alt="Coco" className="w-7 h-7 object-contain" />
                    </Link>

                </div>

                {/* Mobile Menu Button */}
                <button
                    className="md:hidden p-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                >
                    {mobileMenuOpen ? <X /> : <Menu />}
                </button>
            </div>

            {/* Mobile Menu Overlay */}
            <AnimatePresence>
                {mobileMenuOpen && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="md:hidden border-t border-white/10 bg-background/95 backdrop-blur-xl overflow-hidden"
                    >
                        <div className="flex flex-col p-4 gap-4">
                            {navLinks.map((link) => (
                                <Link
                                    key={link.name}
                                    href={link.href}
                                    className="px-4 py-3 text-sm font-medium hover:bg-white/5 rounded-md transition-colors"
                                    onClick={handleLinkClick}
                                >
                                    {link.name}
                                </Link>
                            ))}
                            <div className="flex items-center gap-4 px-4 pt-4 border-t border-white/10">
                                <Link href="/" className="flex items-center gap-2">
                                    <img src="/zylos-logo.png" alt="Zylos Logo" className="w-8 h-8 object-contain" />
                                    <span className="text-xl font-bold hidden md:inline">ZYLOS</span>
                                </Link>
                                <Link href="https://github.com/zylos-ai" target="_blank" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                                    <Github className="w-5 h-5" />
                                    GitHub
                                </Link>
                                <Link href="https://x.com/ZylosAI" target="_blank" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                                    <Twitter className="w-5 h-5" />
                                    Twitter
                                </Link>
                                <Link href="https://discord.gg/GS2J39EGff" target="_blank" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                                    <span>Discord</span>
                                </Link>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </header>
    );
}
