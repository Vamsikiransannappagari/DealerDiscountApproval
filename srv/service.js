const cds=require('@sap/cds');
const {sendPendingApprovalEvent} = require('./utils/alertNotification');


module.exports=cds.service.impl(async function() {

      const {
        PriceLists, PriceConditions, Models, Regions, SalesChannels, Dealers,
        DiscountRequests, DiscountLines, ApprovalMatrix, ApprovalDecisions,
            PricePublicationLogs, PriceChangeHistory
        } = this.entities;

        
  
        //Functions
         this.on('calculateNetPrice', async (req) => {
        const { priceCondition, discountType, discountValue } = req.data;

        const cond = await SELECT.one.from(PriceConditions).where({ ID: priceCondition });
        if (!cond) return req.reject(404, 'Price condition not found.');

        const base  = Number(cond.basePrice);
        const cost  = Number(cond.costPrice);
        const tax   = Number(cond.taxPercentage || 0);
        const value = Number(discountValue || 0);

        let discountAmount, discountPercent;
        if (discountType === 'Percentage') {
            discountPercent = value;
            discountAmount  = base * value / 100;
        } else if (discountType === 'Amount') {
            discountAmount  = value;
            discountPercent = base > 0 ? (value / base) * 100 : 0;
        } else {
            return req.reject(400, 'Discount type must be Percentage or Amount.');
        }

        if (discountPercent < 0 || discountPercent > 100)
            return req.reject(400, 'Discount must be between 0 and 100 percent.');

        const discounted      = base - discountAmount;
        const netPrice        = discounted * (1 + tax / 100);
        const estimatedMargin = discounted > 0 ? ((discounted - cost) / discounted) * 100 : 0;

        // margin floor from the approval matrix
        const model = await SELECT.one.from(Models).where({ ID: cond.model_ID });
        const rows = await SELECT.from(ApprovalMatrix).where({
            status: 'Active', region_ID: cond.region_ID, productFamily: model?.productFamily });
        const hits = rows.filter(m =>
            discountPercent >= Number(m.minimumDiscount) && discountPercent <= Number(m.maximumDiscount));
        const floor = hits.length ? Math.max(...hits.map(m => Number(m.minimumMargin))) : null;

        return {
            discountAmount:  Number(discountAmount.toFixed(2)),
            discountPercent: Number(discountPercent.toFixed(2)),
            netPrice:        Number(netPrice.toFixed(2)),
            estimatedMargin: Number(estimatedMargin.toFixed(2)),
            belowFloor:      floor !== null && estimatedMargin < floor
        };
    });

     this.on('validateMargin', async (req) => {
        const { priceCondition, discountPercentage } = req.data;

        const cond = await SELECT.one.from(PriceConditions).where({ ID: priceCondition });
        if (!cond) return req.reject(404, 'Price condition not found.');

        const base = Number(cond.basePrice);
        const cost = Number(cond.costPrice);
        const tax  = Number(cond.taxPercentage || 0);
        const pct  = Number(discountPercentage || 0);

        if (pct < 0 || pct > 100)
            return req.reject(400, 'Discount must be between 0 and 100 percent.');

        const discountAmount  = base * pct / 100;
        const discounted      = base - discountAmount;
        const netPrice        = discounted * (1 + tax / 100);
        const estimatedMargin = discounted > 0 ? ((discounted - cost) / discounted) * 100 : 0;

        const model = await SELECT.one.from(Models).where({ ID: cond.model_ID });
        const rows = await SELECT.from(ApprovalMatrix).where({
            status: 'Active', region_ID: cond.region_ID, productFamily: model?.productFamily });
        const hits = rows.filter(m =>
            pct >= Number(m.minimumDiscount) && pct <= Number(m.maximumDiscount));
        const floor = hits.length ? Math.max(...hits.map(m => Number(m.minimumMargin))) : null;

        return {
            discountAmount:  Number(discountAmount.toFixed(2)),
            discountPercent: Number(pct.toFixed(2)),
            netPrice:        Number(netPrice.toFixed(2)),
            estimatedMargin: Number(estimatedMargin.toFixed(2)),
            belowFloor:      floor !== null && estimatedMargin < floor
        };
    });

        //Actions
  this.on("submitDiscount", DiscountRequests, async (req) => {
    const ID = getID(req);
    const request = await SELECT.one.from(DiscountRequests).where({ ID });
    if (!request) return req.reject(404, "Discount request not found.");
    if (request.status !== "Draft") return req.reject(400, "Only draft requests can be submitted.");
    if (!isDateValid(request.validFrom, request.validTo))
        return req.reject(400, "Please provide valid request dates.");

    const lines = await SELECT.from(DiscountLines).where({ discountRequest_ID: ID });
    if (!lines.length) return req.reject(400, "Add at least one discount line before submitting.");

    let totalBase = 0, totalDiscount = 0, totalNet = 0, marginValue = 0, marginWeight = 0;
    const required = new Map();

    for (const line of lines) {
        if (!line.priceCondition_ID) return req.reject(400, "Every discount line needs a price condition.");
        const cond = await SELECT.one.from(PriceConditions).where({ ID: line.priceCondition_ID });
        if (!cond) return req.reject(400, "Price condition not found.");
        if (cond.status !== "Active") return req.reject(400, `Condition ${cond.conditionCode} is not active.`);
        if (!isWithinValidity(cond.validFrom, cond.validTo))
            return req.reject(400, `Condition ${cond.conditionCode} is outside its validity period.`);
        if (request.region_ID && cond.region_ID !== request.region_ID)
            return req.reject(400, "Price condition does not belong to the request region.");
        if (request.salesChannel_ID && cond.salesChannel_ID !== request.salesChannel_ID)
            return req.reject(400, "Price condition does not belong to the request sales channel.");

        const qty = Number(line.quantity || 0);
        if (Number(cond.basePrice) <= 0 || qty <= 0)
            return req.reject(400, "Base price and quantity must be greater than zero.");

        const r = computeLine(cond, line.discountType, line.discountValue);
        if (!r || r.discountPercent < 0 || r.discountPercent > 100)
            return req.reject(400, "Invalid discount type or discount value.");
        if (r.discountPercent > Number(cond.maximumDiscount || 0))
            return req.reject(400, `Discount exceeds the maximum for ${cond.conditionCode}.`);

        const matrices = await getMatchingMatrices(cond, r.discountPercent);
        if (!matrices.length)
            return req.reject(400, `No active approval matrix for discount ${r.discountPercent}%.`);

        const floor = Math.max(...matrices.map(m => Number(m.minimumMargin)));
        const belowFloor = r.estimatedMargin < floor;
        if (belowFloor && !matrices.some(m => m.requiresException))
            return req.reject(400, "Margin is below the floor and no exception approval level is configured.");

        for (const m of matrices) {
            if (m.requiresException && !belowFloor) continue;
            required.set(m.approvalLevel, m);
        }

        totalBase     += Number(cond.basePrice) * qty;
        totalDiscount += r.discountAmount * qty;
        totalNet      += r.netPrice * qty;
        marginValue   += r.estimatedMargin * r.discounted * qty;
        marginWeight  += r.discounted * qty;

        await UPDATE(DiscountLines).set({
            model_ID: cond.model_ID, costPrice: cond.costPrice, basePrice: cond.basePrice,
            taxPercentage: cond.taxPercentage, dealerMargin: cond.dealerMargin,
            discountPercentage: r.discountPercent, discountAmount: r.discountAmount,
            netPrice: r.netPrice, totalNetPrice: round2(r.netPrice * qty),
            estimatedMargin: r.estimatedMargin, marginFloorBreached: belowFloor
        }).where({ ID: line.ID });
    }

    const overallMargin = marginWeight > 0 ? round2(marginValue / marginWeight) : 0;
    const route = [...required.values()].sort((a, b) =>
        Number(a.approvalSequence || 0) - Number(b.approvalSequence || 0));

    for (const m of route) {
        await INSERT.into(ApprovalDecisions).entries({
            approvalRole: m.approvalRole, approvalLevel: m.approvalLevel,
            decision: "Pending", sequenceNumber: m.approvalSequence,
            discountRequest_ID: ID, approvalMatrix_ID: m.ID });
    }

    await UPDATE(DiscountRequests).set({
        totalBasePrice: round2(totalBase), totalDiscountPrice: round2(totalDiscount),
        totalNetPrice: round2(totalNet), overallMargin,
        status: "PendingApproval", submittedAt: new Date()
    }).where({ ID });

    // Notify the first responsible approver after database commit
    const firstApproval = route[0];

    if (firstApproval) {
        req.on('succeeded', async () => {
            try {
                await sendPendingApprovalEvent({
                    requestId: ID,
                    requestNumber: request.requestNumber,
                    approvalLevel: firstApproval.approvalLevel,
                    approvalRole: firstApproval.approvalRole
                });

                console.log(
                    `ANS notification sent for ${request.requestNumber}`
                );

            } catch (error) {
                console.error(
                    'ANS notification failed:',
                    error.response?.data || error.message
                );
            }
        });
    }

    return SELECT.one.from(DiscountRequests).where({ ID });
});

   this.on("approveDiscount", DiscountRequests, async (req) => {
    const ID = getID(req);
    const request = await SELECT.one.from(DiscountRequests).where({ ID });
    if (!request) return req.reject(404, "Discount request not found.");
    if (request.status !== "PendingApproval") return req.reject(400, "Only pending requests can be approved.");

    const pending = await SELECT.one.from(ApprovalDecisions)
        .where({ discountRequest_ID: ID, decision: "Pending" }).orderBy("sequenceNumber asc");
    if (!pending) return req.reject(400, "No pending approval decision was found.");

    if (!req.user.is(pending.approvalRole))
        return req.reject(403, "You are not authorised for this approval level.");
    if (request.createdBy === req.user.id)
        return req.reject(403, "You cannot approve your own request.");

    await UPDATE(ApprovalDecisions).set({
        decision: "Approved", comments: req.data.comments,
        approverId: req.user.id, decisionDate: new Date() }).where({ ID: pending.ID });

    const remaining = await SELECT.one.from(ApprovalDecisions)
        .where({ discountRequest_ID: ID, decision: "Pending" });
    if (!remaining) await UPDATE(DiscountRequests).set({ status: "Approved" }).where({ ID });

    return SELECT.one.from(DiscountRequests).where({ ID });
});

this.on("rejectDiscount", DiscountRequests, async (req) => {
    const ID = getID(req);
    const comments = req.data.comments;
    if (!comments?.trim()) return req.reject(400, "Rejection comments are required.");

    const request = await SELECT.one.from(DiscountRequests).where({ ID });
    if (!request) return req.reject(404, "Discount request not found.");
    if (request.status !== "PendingApproval") return req.reject(400, "Only pending requests can be rejected.");

    const pending = await SELECT.one.from(ApprovalDecisions)
        .where({ discountRequest_ID: ID, decision: "Pending" }).orderBy("sequenceNumber asc");
    if (!pending) return req.reject(400, "No pending approval decision was found.");

    await UPDATE(ApprovalDecisions).set({
        decision: "Rejected", comments, approverId: req.user.id, decisionDate: new Date() })
        .where({ ID: pending.ID });

    await UPDATE(ApprovalDecisions).set({
        decision: "Rejected", comments: "Closed: request rejected at an earlier level." })
        .where({ discountRequest_ID: ID, decision: "Pending" });

    await UPDATE(DiscountRequests).set({ status: "Rejected" }).where({ ID });
    return SELECT.one.from(DiscountRequests).where({ ID });
});

this.on("activatePrice", DiscountRequests, async (req) => {
    const ID = getID(req);
    const request = await SELECT.one.from(DiscountRequests).where({ ID });
    if (!request) return req.reject(404, "Discount request not found.");
    if (request.status !== "Approved") return req.reject(400, "Only approved requests can be activated.");
    if (request.validTo < today()) return req.reject(400, "The validity period has already ended.");

    const lines = await SELECT.from(DiscountLines).where({ discountRequest_ID: ID });
    for (const line of lines) {
        const cond = await SELECT.one.from(PriceConditions).where({ ID: line.priceCondition_ID });
        const others = await SELECT.from(PriceConditions).where({
            status: "Active", model_ID: cond.model_ID, region_ID: cond.region_ID,
            salesChannel_ID: cond.salesChannel_ID, dealer_ID: cond.dealer_ID });
        const overlap = others.find(o => o.ID !== cond.ID &&
            request.validFrom <= o.validTo && request.validTo >= o.validFrom);
        if (overlap) return req.reject(400, `Validity overlap with condition ${overlap.conditionCode}.`);
    }

    await UPDATE(DiscountRequests).set({ status: "Active", activatedAt: new Date() }).where({ ID });

    await INSERT.into(PricePublicationLogs).entries({
        discountRequest_ID: ID, status: "Pending", retryCount: 0, targetSystem: "PRICING_SYSTEM" });

    await INSERT.into(PriceChangeHistory).entries({
        fieldName: "status", oldValue: "Approved", newValue: "Active",
        changeReason: `Discount request ${request.requestNumber || ID} activated`,
        changedBy: req.user?.id || "unknown", changedAt: new Date() });

    return SELECT.one.from(DiscountRequests).where({ ID });
});

this.on('deactivatePrice','PriceConditions',async(req)=>{
    const {ID}=req.params[0];
    const {reason}=req.data;
    if(!reason){
        return req.error(400,'Reason is required')
    }
    const condition=await SELECT.one.from(PriceConditions).where({ID});
    await UPDATE(PriceConditions).set({status:'Inactive'}).where({ID});
    await INSERT.into(PriceChangeHistory).entries({
        fieldName:'status',
        oldValue:'Active',
        newValue:'Inactive',
        changeReason:reason,
        changedBy:req.user.id,
        changedAt : new Date(),
        priceCondition_ID:ID
    })
    return 'Price condition successfully deactivated'
});


this.on("activatePriceList", "PriceLists", async (req) => {

    const { ID } = req.params[0];

    // 1. Get Price List
    const priceList = await cds.run(
        SELECT.one.from("PriceLists")
            .where({ ID: ID })
    );

    if (!priceList) {
        return req.reject(404, "Price List not found.");
    }

    // 2. Check Price List status
    if (priceList.status !== "Draft") {
        return req.reject(400, "Only Draft Price Lists can be activated.");
    }

    // 3. Get Price Conditions
    const conditions = await cds.run(
        SELECT.from("PriceConditions")
            .where({ priceList_ID: ID })
    );

    if (!conditions || conditions.length === 0) {
        return req.reject(400, "Add at least one Price Condition before activation.");
    }

    // 4. Validate dates
    if (priceList.validFrom > priceList.validTo) {
        return req.reject(400, "Valid To date must be greater than or equal to Valid From date.");
    }

    // 5. Check valid conditions
    const validConditions = conditions.filter(condition =>
        condition.status !== "Inactive" &&
        condition.status !== "Expired"
    );

    if (validConditions.length === 0) {
        return req.reject(400, "No valid Price Conditions are available for activation.");
    }

    // 6. Update Price List status
    await cds.run(
        UPDATE("PriceLists")
            .set({ status: "Active" })
            .where({ ID: ID })
    );

    return "Price List activated successfully.";
});
this.on('extendPriceValidity','PriceConditions',async(req)=>{
    const {ID}=req.params[0];
    const {newValidTo,reason}=req.data;

    if(!reason || !reason.trim()){
        return req.error(400,'Reason is required');
    } 
    const condition= await SELECT.one.from(PriceConditions).where({ID});
    if(!condition){
        return req.error(404,'Price condition not found');

    }
    if(condition.status!=='Active'){
        return req.error(400,'Only active price consitions can be extended');
    }
    if(!newValidTo){
        return req.error(400,'New validity date is required');
    }
    if(newValidTo<=condition.validTo){
        return req.error(400,'New validity date must be later than the existing validity date');

    }
    const overlap=await SELECT.one.from(PriceConditions).where({
        model_ID:condition.model_ID,
        region_ID:condition.region_ID,
        salesChannel_ID:condition.salesChannel_ID,
        dealer_ID:condition.dealer_ID,
        validFrom:{'<=':newValidTo},
        validTo:{'>=':condition.validFrom}
    }).and({ID:{'!=':ID}});
    if(overlap){
        return req.error(400,'Cannot extend validity because another price condition overlaps');
    }
    await INSERT.into(PriceChangeHistory).entries({
        priceCondition_ID:ID,
        fieldName:'validTo',
        oldValue: String(condition.validTo),
        newValue: String(newValidTo),
        reason:reason,
        changedBy:req.user.id,
        changedAt: new Date()
    });
    return 'Price condition validity extended successfully';

})

// PRICE LISTS - AUTOMATIC CODE GENERATION
this.before('CREATE', PriceLists, async (req) => {

    // Get all existing price list codes
    const existingLists = await SELECT.from(PriceLists)
        .columns('priceListCode');

    let maxNumber = 0;

    // Find the highest numeric suffix
    for (const list of existingLists) {
        const match = list.priceListCode?.match(/^PL-(\d+)$/);

        if (match) {
            const number = Number(match[1]);

            if (number > maxNumber) {
                maxNumber = number;
            }
        }
    }

    // Generate the next code
    const nextNumber = maxNumber + 1;

    req.data.priceListCode =
        `PL-${String(nextNumber).padStart(2, '0')}`;
});

 this.before('CREATE', PriceConditions, async (req) => {

            // Get existing condition codes
            const records = await SELECT.from(PriceConditions)
                .columns('conditionCode');

            // Find the highest existing number
            let maxNumber = 0;

            for (const record of records) {
                const match = record.conditionCode?.match(/^PC-(\d+)$/);

                if (match) {
                    maxNumber = Math.max(maxNumber, Number(match[1]));
                }
            }

            // Generate the next code
            if (!req.data.conditionCode) {
                const nextNumber = maxNumber + 1;

                req.data.conditionCode =
                    `PC-${String(nextNumber).padStart(3, '0')}`;
            }

        });



        // PRICE LIST VALIDATIONS
         this.before(['CREATE', 'UPDATE'], PriceLists, async (req) => {

            const { name, validFrom, validTo } = req.data;

            if (!name) {
                req.error(400, 'Price list name is required.');
            }

            if (!validFrom || !validTo) {
                req.error(400, 'Price list validity dates are required.');
            }

            if (validFrom && validTo && validFrom >= validTo) {
                req.error(400, 'Valid To must be greater than Valid From.');
            }

        });

        this.before('CREATE', 'Models', async (req) => {

    // Get the latest model code
    const lastModel = await cds.run(
        SELECT.one.from('dealerpricing.Models')
            .columns('modelCode')
            .orderBy('modelCode desc')
    );

    let nextNumber = 1;

    if (lastModel && lastModel.modelCode) {
        const lastNumber = parseInt(lastModel.modelCode.split('-')[1]);
        nextNumber = lastNumber + 1;
    }

    // Automatically generate model code
    req.data.modelCode = `MDL-${String(nextNumber).padStart(2, '0')}`;

});

    this.before('CREATE', Regions, async (req) => {

        const lastRegion = await SELECT.one
            .from(Regions)
            .columns('regionCode')
            .orderBy({ regionCode: 'desc' });

        let nextNumber = 1;

        if (lastRegion && lastRegion.regionCode) {
            nextNumber = parseInt(lastRegion.regionCode.split('-')[1]) + 1;
        }

        req.data.regionCode = `REG-${String(nextNumber).padStart(2, '0')}`;

    });

    this.before('CREATE', 'Dealers', async (req) => {

    const lastDealer = await SELECT.one
        .from('dealerpricing.Dealers')
        .columns('dealerCode')
        .orderBy({ dealerCode: 'desc' });

    let nextNumber = 1;

    if (lastDealer && lastDealer.dealerCode) {
        nextNumber = parseInt(lastDealer.dealerCode.split('-')[1]) + 1;
    }

    req.data.dealerCode = `DLR-${String(nextNumber).padStart(2, '0')}`;

});

this.before('CREATE', DiscountRequests, async (req) => {

        const lastRequest = await SELECT.one
            .from(DiscountRequests)
            .columns('requestNumber')
            .orderBy({ requestNumber: 'desc' });

        let nextNumber = 1;

        if (lastRequest && lastRequest.requestNumber) {
            const parts = lastRequest.requestNumber.split('-');
            nextNumber = parseInt(parts[2], 10) + 1;
        }

        req.data.requestNumber =
            `DR-${new Date().getFullYear()}-${String(nextNumber).padStart(4, '0')}`;

    });
 this.before('CREATE', 'ApprovalMatrix', async (req) => {

        // Get the last matrix record
        const lastMatrix = await cds.run(
            SELECT.one
                .from('dealerpricing.ApprovalMatrix')
                .columns('matrixCode')
                .orderBy({ matrixCode: 'desc' })
        );

        let nextNumber = 1;

        if (lastMatrix && lastMatrix.matrixCode) {
            nextNumber =
                parseInt(lastMatrix.matrixCode.split('-')[1]) + 1;
        }

        // Generate matrix code automatically
        req.data.matrixCode =
            `AM-${String(nextNumber).padStart(3, '0')}`;

    });
        // PRICE CONDITION VALIDATIONS

        this.before(['CREATE', 'UPDATE'], PriceConditions, async (req) => {

            const {
                basePrice,
                taxPercentage,
                dealerMargin,
                validFrom,
                validTo,
                priceList_ID,
                model_ID,
                region_ID,
                salesChannel_ID
            } = req.data;

            if (basePrice !== undefined && basePrice <= 0) {
                req.error(400, 'Base price must be greater than zero.');
            }

            if (taxPercentage !== undefined &&
                (taxPercentage < 0 || taxPercentage > 100)) {
                req.error(400, 'Tax percentage must be between 0 and 100.');
            }

            if (dealerMargin !== undefined &&
                (dealerMargin < 0 || dealerMargin > 100)) {
                req.error(400, 'Dealer margin must be between 0 and 100.');
            }

            if (validFrom && validTo && validFrom >= validTo) {
                req.error(400, 'Invalid price condition validity period.');
            }

        });

        //MODEL VALIDATIONS
        this.before(['CREATE', 'UPDATE'], Models, async (req) => {

            if (!req.data.modelName) {
                req.error(400, 'Model name is required.');
            }

        });

        // REGION VALIDATIONS
        this.before(['CREATE', 'UPDATE'], Regions, async (req) => {

            if (!req.data.regionName) {
                req.error(400, 'Region name is required.');
            }

        });

        // SALES CHANNEL VALIDATIONS
        this.before(['CREATE', 'UPDATE'], SalesChannels, async (req) => {

            if (!req.data.channelName) {
                req.error(400, 'Sales channel name is required.');
            }

        });

        //DEALER VALIDATIONS
        this.before(['CREATE', 'UPDATE'], Dealers, async (req) => {

            if (!req.data.dealerName) {
                req.error(400, 'Dealer name is required.');
            }

            if (!req.data.region_ID) {
                req.error(400, 'Dealer region is required.');
            }

        });

        //DISCOUNT REQUEST VALIDATIONS
        this.before(['CREATE', 'UPDATE'], DiscountRequests, async (req) => {

            const {
                dealer_ID,
                reason,
                validFrom,
                validTo,
                status
            } = req.data;

            if (!dealer_ID) {
                req.error(400, 'Dealer selection is mandatory.');
            }

            if (!reason) {
                req.error(400, 'Discount request reason is mandatory.');
            }

            if (validFrom && validTo && validFrom >= validTo) {
                req.error(400, 'Invalid discount request validity period.');
            }

            if (status === 'Approved') {
                req.error(400, 'Discount requests cannot be directly updated to Approved.');
            }

            if (status === 'Rejected') {
                req.error(400, 'Discount requests cannot be directly updated to Rejected.');
            }

        });

        // DISCOUNT LINE VALIDATIONS
        this.before(['CREATE', 'UPDATE'], DiscountLines, async (req) => {

            const {
                quantity,
                basePrice,
                discountPercentage,
                discountAmount,
                netPrice
            } = req.data;

            if (quantity !== undefined && quantity <= 0) {
                req.error(400, 'Quantity must be greater than zero.');
            }

            if (basePrice !== undefined && basePrice <= 0) {
                req.error(400, 'Base price must be greater than zero.');
            }

            if (discountPercentage !== undefined &&
                (discountPercentage < 0 || discountPercentage > 100)) {
                req.error(400, 'Invalid discount percentage.');
            }

            if (discountAmount !== undefined && discountAmount < 0) {
                req.error(400, 'Discount amount cannot be negative.');
            }

            if (netPrice !== undefined && netPrice < 0) {
                req.error(400, 'Net price cannot be negative.');
            }

        });

        // APPROVAL MATRIX VALIDATIONS

         this.before(['CREATE', 'UPDATE'], ApprovalMatrix, async (req) => {

            const {
                discountThreshold,
                minimumMargin,
                validFrom,
                validTo
            } = req.data;

            if (discountThreshold !== undefined &&
                (discountThreshold < 0 || discountThreshold > 100)) {
                req.error(400, 'Discount threshold must be between 0 and 100.');
            }

            if (minimumMargin !== undefined &&
                (minimumMargin < 0 || minimumMargin > 100)) {
                req.error(400, 'Minimum margin must be between 0 and 100.');
            }

            if (validFrom && validTo && validFrom >= validTo) {
                req.error(400, 'Invalid approval matrix validity period.');
            }

        });

        // APPROVAL DECISION VALIDATIONS

         this.before(['CREATE', 'UPDATE'], ApprovalDecisions, async (req) => {

            const { discountRequest_ID, decision, comments } = req.data;

            if (!discountRequest_ID) {
                req.error(400, 'Discount request reference is required.');
            }

            if (!decision) {
                req.error(400, 'Approval decision is required.');
            }

            if (decision === 'Rejected' && !comments) {
                req.error(400, 'Rejection comments are mandatory.');
            }

        });

        // PRICE CONDITIONS - MAXIMUM DISCOUNT VALIDATION

        this.before(['CREATE', 'UPDATE'], PriceConditions, async (req) => {

            const { maximumDiscount } = req.data;

            if (maximumDiscount === undefined) return;

            if (Number(maximumDiscount) < 0 ||
                Number(maximumDiscount) > 100) {

                return req.reject(
                    400,
                    'Maximum discount must be between 0 and 100.'
                );
            }

        });

        // PRICE CONDITIONS - DUPLICATE CONDITION CODE VALIDATION

        this.before(['CREATE', 'UPDATE'], PriceConditions, async (req) => {

            const conditionCode = req.data.conditionCode;

            if (!conditionCode) return;

            const existing = await SELECT.from(PriceConditions)
                .where({ conditionCode });

            const currentID = getID(req);

            const duplicate = existing.some(record =>
                record.ID !== currentID
            );

            if (duplicate) {
                return req.reject(
                    400,
                    'Condition code already exists.'
                );
            }

        });

            // PRICE LISTS - UNIQUE CODE VALIDATION

this.before(['CREATE', 'UPDATE'], PriceLists, async (req) => {

    const { priceListCode } = req.data;

    if (!priceListCode) return;

    const existing = await SELECT.from(PriceLists)
        .where({ priceListCode });

    const currentID = getID(req);

    if (existing.some(record => record.ID !== currentID)) {
        return req.reject(
            400,
            'Price list code already exists.'
        );
    }

});

// PRICE LISTS - VALIDITY DATE VALIDATION

this.before(['CREATE', 'UPDATE'], PriceLists, async (req) => {

    let oldRecord = null;

    if (req.event === 'UPDATE') {
        oldRecord = await SELECT.one
            .from(PriceLists)
            .where({ ID: getID(req) });
    }

    const data = {
        ...(oldRecord || {}),
        ...req.data
    };

    const { validFrom, validTo } = data;

    if (!validFrom || !validTo) {
        return req.reject(
            400,
            'Price list validity dates are required.'
        );
    }

    if (validFrom > validTo) {
        return req.reject(
            400,
            'Valid To must be on or after Valid From.'
        );
    }

});

// DISCOUNT LINES - ACTIVE PRICE CONDITION VALIDATION

this.before(['CREATE', 'UPDATE'], DiscountLines, async (req) => {

    const oldLine = req.event === 'UPDATE'
        ? await SELECT.one.from(DiscountLines)
            .where({ ID: getID(req) })
        : null;

    const data = { ...(oldLine || {}), ...req.data };

    if (!data.priceCondition_ID) {
        return req.reject(400, 'Price condition is required.');
    }

    const condition = await SELECT.one.from(PriceConditions)
        .where({ ID: data.priceCondition_ID });

    if (!condition) {
        return req.reject(404, 'Price condition not found.');
    }

    if (condition.status !== 'Active') {
        return req.reject(400, 'Price condition must be Active.');
    }

});

// DISCOUNT LINES - REQUEST DATE VALIDATION

this.before(['CREATE', 'UPDATE'], DiscountLines, async (req) => {

    const oldLine = req.event === 'UPDATE'
        ? await SELECT.one.from(DiscountLines)
            .where({ ID: getID(req) })
        : null;

    const data = { ...(oldLine || {}), ...req.data };

    if (!data.priceCondition_ID || !data.discountRequest_ID) return;

    const condition = await SELECT.one.from(PriceConditions)
        .where({ ID: data.priceCondition_ID });

    const request = await SELECT.one.from(DiscountRequests)
        .where({ ID: data.discountRequest_ID });

    if (!condition || !request) return;

    if (request.validFrom < condition.validFrom ||
        request.validTo > condition.validTo) {

        return req.reject(
            400,
            'Price condition must cover the complete discount request validity period.'
        );
    }

});

// DISCOUNT LINES - MAXIMUM DISCOUNT VALIDATION

this.before(['CREATE', 'UPDATE'], DiscountLines, async (req) => {

    const oldLine = req.event === 'UPDATE'
        ? await SELECT.one.from(DiscountLines)
            .where({ ID: getID(req) })
        : null;

    const data = { ...(oldLine || {}), ...req.data };

    if (!data.priceCondition_ID ||
        data.discountValue === undefined ||
        !data.discountType) return;

    const condition = await SELECT.one.from(PriceConditions)
        .where({ ID: data.priceCondition_ID });

    if (!condition) {
        return req.reject(404, 'Price condition not found.');
    }

    const result = computeLine(
        condition,
        data.discountType,
        data.discountValue
    );

    if (!result || result.discountPercent < 0 ||
        result.discountPercent > Number(condition.maximumDiscount)) {

        return req.reject(
            400,
            'Discount exceeds the maximum allowed discount.'
        );
    }

});

// DISCOUNT LINES - AUTOMATIC CALCULATION

this.before(['CREATE', 'UPDATE'], DiscountLines, async (req) => {

    const oldLine = req.event === 'UPDATE'
        ? await SELECT.one.from(DiscountLines)
            .where({ ID: getID(req) })
        : null;

    const data = { ...(oldLine || {}), ...req.data };

    if (!data.priceCondition_ID ||
        data.quantity === undefined ||
        data.discountValue === undefined ||
        !data.discountType) return;

    const condition = await SELECT.one.from(PriceConditions)
        .where({ ID: data.priceCondition_ID });

    if (!condition) {
        return req.reject(404, 'Price condition not found.');
    }

    const quantity = Number(data.quantity);

    if (quantity <= 0) {
        return req.reject(400, 'Quantity must be greater than zero.');
    }

    const result = computeLine(
        condition,
        data.discountType,
        data.discountValue
    );

    if (!result) {
        return req.reject(400, 'Invalid discount type.');
    }

    req.data.basePrice = condition.basePrice;
    req.data.costPrice = condition.costPrice;
    req.data.taxPercentage = condition.taxPercentage;
    req.data.discountPercentage = result.discountPercent;
    req.data.discountAmount = result.discountAmount;
    req.data.netPrice = result.netPrice;
    req.data.totalNetPrice = round2(result.netPrice * quantity);
    req.data.estimatedMargin = result.estimatedMargin;

});


// DISCOUNT REQUESTS - REQUEST NUMBER GENERATION

this.before('CREATE', DiscountRequests, async (req) => {

    if (req.data.requestNumber) return;

    const { SELECT } = cds.ql;

    const result = await SELECT.one
        .from(DiscountRequests)
        .columns('max(requestNumber) as maximum');

    const nextNumber = Number(result?.maximum || 0) + 1;

    req.data.requestNumber = `DR-${String(nextNumber).padStart(5, '0')}`;

});

// DISCOUNT REQUESTS - DRAFT ONLY UPDATE VALIDATION

this.before('UPDATE', DiscountRequests, async (req) => {

    const request = await SELECT.one
        .from(DiscountRequests)
        .where({ ID: getID(req) });

    if (!request) {
        return req.reject(404, 'Discount request not found.');
    }

    if (request.status !== 'Draft') {
        return req.reject(
            400,
            'Only Draft discount requests can be edited.'
        );
    }

});

// APPROVAL MATRIX - DISCOUNT RANGE VALIDATION

this.before(['CREATE', 'UPDATE'], ApprovalMatrix, async (req) => {

    let oldRecord = null;

    if (req.event === 'UPDATE') {
        oldRecord = await SELECT.one
            .from(ApprovalMatrix)
            .where({ ID: getID(req) });
    }

    const data = { ...(oldRecord || {}), ...req.data };

    const min = Number(data.minimumDiscount);
    const max = Number(data.maximumDiscount);

    if (data.minimumDiscount === undefined ||
        data.maximumDiscount === undefined ||
        min >= max) {

        return req.reject(
            400,
            'Minimum discount must be less than maximum discount.'
        );
    }

});


// APPROVAL MATRIX - DISCOUNT RANGE VALIDATION

this.before(['CREATE', 'UPDATE'], ApprovalMatrix, async (req) => {

    let oldRecord = null;

    if (req.event === 'UPDATE') {
        oldRecord = await SELECT.one
            .from(ApprovalMatrix)
            .where({ ID: getID(req) });
    }

    const data = { ...(oldRecord || {}), ...req.data };

    const min = Number(data.minimumDiscount);
    const max = Number(data.maximumDiscount);

    if (data.minimumDiscount === undefined ||
        data.maximumDiscount === undefined ||
        min >= max) {

        return req.reject(
            400,
            'Minimum discount must be less than maximum discount.'
        );
    }

});


// PRICE CONDITIONS - CAPTURE OLD VALUES

this.before('UPDATE', PriceConditions, async (req) => {

    const ID = getID(req);

    const oldRecord = await SELECT.one
        .from(PriceConditions)
        .where({ ID });

    if (!oldRecord) {
        return req.reject(404, 'Price condition not found.');
    }

    req._oldPriceCondition = oldRecord;

});

// PRICE CONDITIONS - SAVE FIELD CHANGE HISTORY

this.after('UPDATE', PriceConditions, async (result, req) => {

    const oldRecord = req._oldPriceCondition;

    if (!oldRecord) return;

    const newRecord = await SELECT.one
        .from(PriceConditions)
        .where({ ID: getID(req) });

    if (!newRecord) return;

    const ignoredFields = [
        'ID',
        'createdAt',
        'createdBy',
        'modifiedAt',
        'modifiedBy'
    ];

    for (const field of Object.keys(req.data)) {

        if (ignoredFields.includes(field)) continue;

        const oldValue = oldRecord[field];
        const newValue = newRecord[field];

        if (String(oldValue ?? '') !== String(newValue ?? '')) {

            await INSERT.into(PriceChangeHistory).entries({

                fieldName: field,
                oldValue: String(oldValue ?? ''),
                newValue: String(newValue ?? ''),
                changedBy: req.user?.id || 'unknown',
                changedAt: new Date(),
                priceCondition_ID: oldRecord.ID

            });

        }

    }

});

        //jobscheduler
     
this.on("activateAndExpirePrices", async (req) => {

    const t = today();

    let priceListsActivated = 0;
    let priceListsExpired = 0;
    let activated = 0;
    let requestsExpired = 0;
    let conditionsExpired = 0;

    const failed = [];

    // --------------------------------------------------
    // 1. ACTIVATE PRICE LISTS
    // Draft -> Active
    // --------------------------------------------------

    const listsToActivate = await SELECT.from(PriceLists).where({
        status: "Draft",
        validFrom: { "<=": t },
        validTo: { ">=": t }
    });

    for (const list of listsToActivate) {
        try {
            await UPDATE(PriceLists)
                .set({ status: "Active" })
                .where({ ID: list.ID });

            await INSERT.into(PriceChangeHistory).entries({
                fieldName: "status",
                oldValue: "Draft",
                newValue: "Active",
                changeReason: "Price list automatically activated by Job Scheduler",
                changedBy: "JobScheduler",
                changedAt: new Date()
            });

            priceListsActivated++;

        } catch (e) {
            failed.push(
                `PriceList ${list.priceListCode}: ${e.message}`
            );
        }
    }


    // --------------------------------------------------
    // 2. EXPIRE PRICE LISTS
    // Active -> Inactive
    // --------------------------------------------------

    const listsToExpire = await SELECT.from(PriceLists).where({
        status: "Active",
        validTo: { "<": t }
    });

    for (const list of listsToExpire) {
        try {
            await UPDATE(PriceLists)
                .set({ status: "Inactive" })
                .where({ ID: list.ID });

            await INSERT.into(PriceChangeHistory).entries({
                fieldName: "status",
                oldValue: "Active",
                newValue: "Inactive",
                changeReason: "Price list validity ended; automatically deactivated by Job Scheduler",
                changedBy: "JobScheduler",
                changedAt: new Date()
            });

            priceListsExpired++;

        } catch (e) {
            failed.push(
                `PriceList ${list.priceListCode}: ${e.message}`
            );
        }
    }


    // --------------------------------------------------
    // 3. ACTIVATE APPROVED DISCOUNT REQUESTS
    // Approved -> Active
    // --------------------------------------------------

    const approvedRequests = await SELECT.from(DiscountRequests).where({
        status: "Approved",
        validFrom: { "<=": t },
        validTo: { ">=": t }
    });

    requestLoop:
    for (const request of approvedRequests) {

        try {

            const lines = await SELECT.from(DiscountLines).where({
                discountRequest_ID: request.ID
            });

            for (const line of lines) {

                const cond = await SELECT.one.from(PriceConditions).where({
                    ID: line.priceCondition_ID
                });

                if (!cond) {
                    failed.push(
                        `Request ${request.requestNumber}: PriceCondition ${line.priceCondition_ID} not found`
                    );
                    continue requestLoop;
                }

                const activeConditions = await SELECT.from(PriceConditions).where({
                    model_ID: cond.model_ID,
                    region_ID: cond.region_ID,
                    salesChannel_ID: cond.salesChannel_ID,
                    dealer_ID: cond.dealer_ID,
                    status: "Active"
                });

                const hasOverlap = activeConditions.some(existing => {

                    if (existing.ID === cond.ID) {
                        return false;
                    }

                    return (
                        existing.validFrom <= cond.validTo &&
                        existing.validTo >= cond.validFrom
                    );
                });

                if (hasOverlap) {
                    failed.push(
                        `Request ${request.requestNumber}: overlapping active price condition found`
                    );
                    continue requestLoop;
                }
            }

            await UPDATE(DiscountRequests)
                .set({
                    status: "Active",
                    activatedAt: new Date()
                })
                .where({ ID: request.ID });

            await INSERT.into(PricePublicationLogs).entries({
                discountRequest_ID: request.ID,
                status: "Pending",
                retryCount: 0,
                targetSystem: "PRICING_SYSTEM"
            });

            await INSERT.into(PriceChangeHistory).entries({
                fieldName: "status",
                oldValue: "Approved",
                newValue: "Active",
                changeReason: "Discount request automatically activated by Job Scheduler",
                changedBy: "JobScheduler",
                changedAt: new Date()
            });

            activated++;

        } catch (e) {
            failed.push(
                `Request ${request.requestNumber}: ${e.message}`
            );
        }
    }


    // --------------------------------------------------
    // 4. EXPIRE DISCOUNT REQUESTS
    // Active / Approved -> Expired
    // --------------------------------------------------

    const expiredRequests = await SELECT.from(DiscountRequests).where({
        status: { in: ["Active", "Approved"] },
        validTo: { "<": t }
    });

    for (const request of expiredRequests) {

        try {

            const oldStatus = request.status;

            await UPDATE(DiscountRequests)
                .set({ status: "Expired" })
                .where({ ID: request.ID });

            await INSERT.into(PriceChangeHistory).entries({
                fieldName: "status",
                oldValue: oldStatus,
                newValue: "Expired",
                changeReason: "Discount request validity ended",
                changedBy: "JobScheduler",
                changedAt: new Date()
            });

            requestsExpired++;

        } catch (e) {
            failed.push(
                `Request ${request.requestNumber}: ${e.message}`
            );
        }
    }


    // --------------------------------------------------
    // 5. EXPIRE PRICE CONDITIONS
    // Active -> Expired
    // --------------------------------------------------

    const expiredConditions = await SELECT.from(PriceConditions).where({
        status: "Active",
        validTo: { "<": t }
    });

    for (const condition of expiredConditions) {

        try {

            await UPDATE(PriceConditions)
                .set({ status: "Expired" })
                .where({ ID: condition.ID });

            await INSERT.into(PriceChangeHistory).entries({
                priceCondition_ID: condition.ID,
                fieldName: "status",
                oldValue: "Active",
                newValue: "Expired",
                changeReason: "Price condition validity ended",
                changedBy: "JobScheduler",
                changedAt: new Date()
            });

            conditionsExpired++;

        } catch (e) {
            failed.push(
                `PriceCondition ${condition.conditionCode}: ${e.message}`
            );
        }
    }


    // --------------------------------------------------
    // 6. RETURN JOB SCHEDULER SUMMARY
    // --------------------------------------------------

    return (
        `Price Lists Activated: ${priceListsActivated}, ` +
        `Price Lists Deactivated: ${priceListsExpired}, ` +
        `Discount Requests Activated: ${activated}, ` +
        `Discount Requests Expired: ${requestsExpired}, ` +
        `Price Conditions Expired: ${conditionsExpired}, ` +
        `Failed: ${failed.length}` +
        (failed.length ? ` | Errors: ${failed.join("; ")}` : "")
    );

});


        const today = () => new Date().toISOString().slice(0, 10);

        const getID = req => {
            const p = req.params?.[req.params.length - 1];
            return typeof p === 'object' ? p.ID : p;
        };
        //Rounds the number to 2 decimal places and returns it as a string
        const round2 = n => Number(Number(n).toFixed(2));

        const computeLine = (cond, discountType, discountValue) => {
            const base = Number(cond.basePrice);
            const cost = Number(cond.costPrice);
            const tax  = Number(cond.taxPercentage || 0);
            const value = Number(discountValue || 0);
            let pct, amount;
            if (discountType === 'Percentage') { pct = value; amount = round2(base * pct / 100); }
            else if (discountType === 'Amount') { amount = value; pct = base > 0 ? round2(amount / base * 100) : -1; }
            else return null;
            const discounted = round2(base - amount);
            return {
                discountPercent: pct, discountAmount: amount, discounted,
                netPrice: round2(discounted * (1 + tax / 100)),
                estimatedMargin: calculateMargin(discounted, cost)
            };
        };

        const getMatchingMatrices = async (cond, pct) => {
            const model = await SELECT.one.from(Models).where({ ID: cond.model_ID });
            const rows = await SELECT.from(ApprovalMatrix).where({
                status: 'Active', region_ID: cond.region_ID, productFamily: model?.productFamily });
            const t = today();
            return rows.filter(m =>
                (!m.validFrom || m.validFrom <= t) && (!m.validTo || m.validTo >= t) &&
                pct >= Number(m.minimumDiscount) && pct <= Number(m.maximumDiscount));
        };

        const evaluate = async (req, priceCondition, discountType, discountValue) => {
            const cond = await SELECT.one.from(PriceConditions).where({ ID: priceCondition });
            if (!cond) return req.reject(404, 'Price condition not found.');
            const r = computeLine(cond, discountType, discountValue);
            if (!r || r.discountPercent < 0 || r.discountPercent > 100)
                return req.reject(400, 'Invalid discount type or value.');
            const matrices = await getMatchingMatrices(cond, r.discountPercent);
            const floor = matrices.length ? Math.max(...matrices.map(m => Number(m.minimumMargin))) : null;
            return {
                discountAmount: r.discountAmount, discountPercent: r.discountPercent,
                netPrice: r.netPrice, estimatedMargin: r.estimatedMargin,
                belowFloor: floor !== null && r.estimatedMargin < floor
            };
        };

        const calculateNet = (basePrice, discountPercentage) => {
            return Number(
                (Number(basePrice) *
                    (1 - Number(discountPercentage) / 100)).toFixed(2)
            );
        };

        const calculateMargin = (sellingPrice, costPrice) => {
            if (Number(sellingPrice) <= 0) return 0;

            return Number(
                (
                    ((Number(sellingPrice) - Number(costPrice)) /
                        Number(sellingPrice)) *
                    100
                ).toFixed(2)
            );
        };

        const isDateValid = (from, to) => {
            return from && to && from <= to;
        };

        const isWithinValidity = (from, to) => {
            const currentDate = today();
            return from <= currentDate && to >= currentDate;
        };

  


    
})