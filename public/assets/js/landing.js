// Halaman pemasaran: sambungkan tombol WhatsApp dengan draft yang sesuai.
import { $$, mountDemoBar, waOrder, waHelp } from './ui.js';

mountDemoBar();

$$('[data-wa]').forEach((a) => {
  a.href = a.dataset.wa === 'help' ? waHelp() : waOrder();
});