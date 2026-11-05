import { $, mountDemoBar, waLink } from './ui.js';

mountDemoBar();
$('#wa-link').href = waLink();
