namespace dealerpricing;
using {cuid,managed} from '@sap/cds/common';


entity PriceLists : cuid, managed {

    priceListCode : String(30) @readonly;
    name          : String(100) @mandatory;
    description   : String(500);
    currency      : CurrencyCode;
    status        : PriceListStatus default 'Draft';
    validFrom     : Date @mandatory;
    validTo       : Date @mandatory;
    conditions : Composition of many PriceConditions on conditions.priceList=$self;
}

entity PriceConditions :cuid,managed{
    costPrice : Money @mandatory;
    conditionCode : String @readonly;
    basePrice : Money @mandatory;
    taxPercentage : Percentage @assert.range:[0,100];
    dealerMargin : Percentage @assert.range:[0,100];
    discountType : DiscountType;
    maximumDiscount : Percentage @assert.range:[0,100];
    currency : CurrencyCode;
    validFrom : Date @mandatory;
    validTo : Date @mandatory;
    status : PricingConditionStatus default 'Draft';
    priceList : Association to one PriceLists;
    model : Association to one Models;
    region : Association to one Regions;
    salesChannel : Association to one SalesChannels;
    dealer : Association to one Dealers;
}

entity Models : cuid,managed{
    modelCode : String;
    modelName : String;
    productFamily : String;
    description : String;
    status : MasterStatus default 'Active';
}

entity Regions : cuid,managed{
    regionCode : String;
    regionName : String;
    country : String;
    state : String;
    status : MasterStatus default 'Active';
}

entity SalesChannels : cuid,managed{
    channelCode : String;
    channelName : String;
    description : String;
    status : MasterStatus default 'Active';
}

entity Dealers : cuid,managed{
    dealerCode : String;
    dealerName : String;
    contactPerson : String;
    email : String;
    phone : String;
    address : String;
    status :MasterStatus default 'Active';
    region : Association to one Regions;
}

entity DiscountRequests:cuid,managed{
    requestNumber : String @readonly;
    requestDate : Date;
    requestedBy : String;
    reason : String;
    supportingDetails : String;
    totalBasePrice : Money @readonly;
    totalDiscountPrice : Money @readonly;
    totalNetPrice : Money @readonly;
    overallMargin : Percentage @assert.range:[0,100] @readonly;
    status : DiscountRequestStatus default 'Draft' @readonly;
    validFrom : Date;
    validTo : Date;
    submittedAt : Timestamp @readonly;
    dealer : Association to one Dealers;
    region : Association to one Regions;
    salesChannel : Association to one SalesChannels;
    lines : Composition of many DiscountLines on lines.discountRequest=$self;
    approvalDecisions : Composition of many ApprovalDecisions on approvalDecisions.discountRequest=$self;
    publicationLogs : Composition of many PricePublicationLogs on publicationLogs.discountRequest=$self;
}

entity DiscountLines : cuid,managed{
    costPrice : Money;   
    quantity : Integer @mandatory;
    basePrice : Money;
    taxPercentage : Percentage @assert.range:[0,100];
    dealerMargin : Percentage;
    discountType : DiscountType;
    discountPercentage : Percentage;
    discountAmount : Money @readonly;
    netPrice : Money @readonly;
    totalNetPrice : Money @readonly;
    estimatedMargin : Percentage @readonly;
    discountRequest : Association to one DiscountRequests;
    model : Association to one Models;
    priceCondition : Association to one PriceConditions;
}

entity ApprovalMatrix : cuid,managed{
    matrixCode : String;
    productFamily : String;
    minimumDiscount : Percentage @mandatory @assert.range: [0, 100];
    maximumDiscount : Percentage @mandatory @assert.range: [0, 100];
    minimumMargin : Percentage @mandatory @assert.range: [0, 100];
    approvalLevel : ApprovalLevel @mandatory;
    approvalSequence : Integer;
    approvalRole : String;
    requiresException : Boolean default false;
    validFrom : Date;
    validTo : Date;
    status : ApprovalMatrixStatus default 'Active';
    region : Association to one Regions;
}

entity ApprovalDecisions : cuid,managed{
    approverId : String;
    approvalRole : String;
    approvalLevel : ApprovalLevel;
    decision : ApprovalDecisionStatus default 'Pending';
    comments : String;
    decisionDate : Timestamp;
    sequenceNumber : Integer;
    discountRequest : Association to one DiscountRequests;
    approvalMatrix : Association to one ApprovalMatrix;
}

entity PricePublicationLogs : cuid,managed{
    retryCount : Integer default 0;
    publicationReference : String;
    targetSystem : String;
    payload : LargeString;
    status : PublicationStatus default 'Pending';
    responseMessage : String;
    publishedAt : Timestamp;
    lastAttemptAt : Timestamp;
    discountRequest : Association to one DiscountRequests;

}

entity PriceChangeHistory : cuid,managed{
    fieldName : String;
    oldValue : String;
    newValue : String;
    changeReason : String;
    changedBy : String;
    changedAt : Timestamp;
    priceCondition : Association to one PriceConditions;
}

type PriceListStatus : String enum{
    Draft;
    Active;
    Inactive
}   

type PricingConditionStatus : String enum{
    Draft;
    Active;
    Expired;
    Inactive
}

type DiscountRequestStatus: String enum{
    Draft;
    PendingApproval;
    Approved;
    Rejected;
    Active;
    Expired
}

type DiscountType : String enum {
    Percentage = 'Percentage';
    Amount = 'Amount';
}

type ApprovalDecisionStatus : String enum {
    Pending = 'Pending';
    Approved = 'Approved';
    Rejected = 'Rejected';
}

type ApprovalLevel : String enum {
    RegionalManager = 'Regional Manager';
    FinanceApprover = 'Finance Approver';
}

type PublicationStatus : String enum {
    Pending = 'Pending';
    Success = 'Success';
    Failed = 'Failed';
}

type MasterStatus : String enum {
    Active = 'Active';
    Inactive = 'Inactive';
}

type ApprovalMatrixStatus : String enum {
    Active = 'Active';
    Inactive = 'Inactive';
}

type CurrencyCode : String;
type Percentage : Decimal;
type Money : Decimal;

