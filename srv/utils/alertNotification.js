
const axios = require("axios");

// Generate OAuth access token
async function getAccessToken() {
    const response = await axios.post(
        process.env.ANS_OAUTH_URL,
        new URLSearchParams({
            grant_type: "client_credentials"
        }),
        {
            auth: {
                username: process.env.ANS_CLIENT_ID,
                password: process.env.ANS_CLIENT_SECRET
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        }
    );

    return response.data.access_token;
}

// Send pending approval event
async function sendPendingApprovalEvent(data) {

    const token = await getAccessToken();

    // ADD YOUR EVENT OBJECT HERE
    const event = {
        eventType: "DiscountApprovalPending",
        resource: {
            resourceName: "DealerDiscountApproval",
            resourceType: "application"
        },
        severity: "INFO",
        category: "NOTIFICATION",
        subject: "Dealer Discount Approval Required",
        body: `Request ${data.requestNumber} requires ${data.approvalLevel} approval.`,
        tags: {
            requestId: String(data.requestId),
            requestNumber: String(data.requestNumber),
            approvalLevel: String(data.approvalLevel),
            approvalRole: String(data.approvalRole)
        }
    };

    const response = await axios.post(
        `${process.env.ANS_URL}/cf/producer/v1/resource-events`,
        event,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        }
    );

    return response.data;
}

module.exports = {
    sendPendingApprovalEvent
};
