import { Router, type IRouter } from "express";
import healthRouter from "./health";
import geminiRouter from "./gemini";
import jarvisRouter from "./jarvis";
import whatsappRouter from "./whatsapp";

const router: IRouter = Router();

router.use(healthRouter);
router.use(geminiRouter);
router.use(jarvisRouter);
router.use(whatsappRouter);

export default router;
