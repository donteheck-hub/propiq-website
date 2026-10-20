import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'PropIQ | Prop Research',description:'NFL & NBA player prop analytics with historical hit rates and live bookmaker lines.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
