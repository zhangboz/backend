// backend/routes/loginRouter.mjs
import express from 'express';
import axios from 'axios';
// dotenv config is handled by server.mjs, process.env will be populated.

const router = express.Router();

// Login Route
router.post('/wechat', async (req, res) => {
    const { code } = req.body;
    const appId = process.env.WX_APP_ID;
    const appSecret = process.env.WX_APP_SECRET;

    console.log('[Login Router] Received login request with code:', code);

    if (!code) return res.status(400).json({ success: false, message: '缺少 code 参数' });
    if (!appId || !appSecret) {
        console.error('[Login Router] 错误: WX_APP_ID 或 WX_APP_SECRET 未在 .env 文件中配置');
        return res.status(500).json({ success: false, message: '服务器配置错误' });
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;

    try {
        const response = await axios.get(url);
        const wechatData = response.data;
        console.log('[Login Router] WeChat API response:', wechatData);

        if (wechatData.errcode && wechatData.errcode !== 0) {
            console.error('[Login Router] 微信 API 错误:', wechatData.errmsg);
            return res.status(400).json({ success: false, message: `微信登录失败: ${wechatData.errmsg}`, errcode: wechatData.errcode });
        }

        const { openid, session_key } = wechatData; // session_key might be useful later
        console.log(`[Login Router] 成功获取 openid: ${openid}`);
        res.json({ success: true, message: '登录成功', openid: openid });

    } catch (error) {
        console.error('[Login Router] 请求微信 API 时出错:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '请求微信服务时出错' });
    }
});

export default router;