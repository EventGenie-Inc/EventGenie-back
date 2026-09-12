import {} from 'express';
export const captureRawBody = (req, _res, buf) => {
    req.rawBody = buf;
};
//# sourceMappingURL=raw-body.middleware.js.map