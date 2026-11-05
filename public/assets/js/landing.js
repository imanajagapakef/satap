// Halaman pemasaran: sambungkan semua tombol WhatsApp.
import { $$, mountDemoBar, waLink } from './ui.js';

mountDemoBar();
$$('[data-wa]').forEach((a) => { a.href = waLink(); });
