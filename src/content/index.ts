import { PageAgent } from './page-agent/page-agent';
import { extractAndSendToken, watchTokenChanges } from './token-extractor';
import { injectCursorOverride } from './cursor-override';

// Initialize token extraction
extractAndSendToken();
watchTokenChanges();

// Initialize Page Agent
const pageAgent = new PageAgent();
pageAgent.start();

// Inject cursor style override
injectCursorOverride();

console.log('[XGEN Extension] Content script loaded');
