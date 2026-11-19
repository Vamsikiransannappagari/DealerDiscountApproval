using dealerpricing as d from '../db/schema';

type NetPriceResult {
    discountAmount  : Decimal(15, 2);
    discountPercent : Decimal(7, 2);
    netPrice        : Decimal(15, 2);
    estimatedMargin : Decimal(7, 2);
    belowFloor      : Boolean;
}

@odata
@requires : 'authenticated-user'
service DealerService {
    @restrict:[
        {grant:'READ',to:['PricingAnalyst','DealerSalesUser','RegionalManager','FinanceApprover','PricingAdministrator']},
        {grant:['CREATE','UPDATE'],to:'PricingAnalyst'},
        {grant:'DELETE',to:'PricingAdministrator'}
    ]
    entity PriceLists           as projection on d.PriceLists;

    @restrict:[
        {grant:'READ',to:['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator']},
        {grant:['CREATE','UPDATE'],to:'PricingAnalyst'},
        {grant:'DELETE',to:'PricingAdministrator'}
    ]
    entity PriceConditions      as projection on d.PriceConditions actions{
        action deactivatePrice(reason:String) returns String;
        action extendPriceValidity(newValidTo: Date,reason: String) returns String;
    };

    @restrict:[
        {grant:'READ',to:['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator']},
        {grant:['CREATE','UPDATE','DELETE'],to:'PricingAdministrator'}
    ]
    entity Models               as projection on d.Models;

    @restrict:[
        {grant:'READ',to:['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator']},
        {grant:['CREATE','UPDATE','DELETE'],to:'PricingAdministrator'}
    ]
    entity Regions              as projection on d.Regions;

    @restrict: [
        { grant: 'READ', to: ['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'PricingAdministrator' }
    ]
    entity SalesChannels        as projection on d.SalesChannels;

    @restrict: [
        { grant: 'READ', to: ['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'PricingAdministrator' }
    ]
    entity Dealers              as projection on d.Dealers;

    @restrict: [
        { grant: 'READ', to: ['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: 'CREATE', to: 'DealerSalesUser' },
        { grant: 'UPDATE', to: 'DealerSalesUser' },
        { grant: 'DELETE', to: 'PricingAdministrator' },
        { grant: 'submitDiscount',  to: 'DealerSalesUser' },
        { grant: 'approveDiscount', to: ['RegionalManager', 'FinanceApprover'] },
        { grant: 'rejectDiscount',  to: ['RegionalManager', 'FinanceApprover'] },
        { grant: 'activatePrice',   to: 'PricingAdministrator' }
    ]
    entity DiscountRequests     as projection on d.DiscountRequests
        actions {
            action submitDiscount()                  returns String;

            action approveDiscount(comments: String) returns String;

            action rejectDiscount(comments: String)  returns String;
            action activatePrice()                   returns String;
        };

    @restrict: [
        { grant: 'READ', to: ['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: ['CREATE', 'UPDATE'], to: 'DealerSalesUser' },
        { grant: 'DELETE', to: 'PricingAdministrator' }
    ]
    entity DiscountLines        as projection on d.DiscountLines;

    @restrict: [
        { grant: 'READ', to: ['PricingAnalyst', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'PricingAdministrator' }
    ]
    entity ApprovalMatrix       as projection on d.ApprovalMatrix;

    @restrict: [
        { grant: 'READ', to: ['DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] },
        { grant: ['CREATE', 'UPDATE'], to: ['RegionalManager', 'FinanceApprover'] },
        {grant:'DELETE',to:['PricingAdministrator']}
    ]
    entity ApprovalDecisions    as projection on d.ApprovalDecisions;

    @restrict: [
        { grant: ['CREATE','READ','UPDATE','DELETE'], to: ['PricingAnalyst', 'PricingAdministrator'] },
    ]
    entity PricePublicationLogs as projection on d.PricePublicationLogs;


    @restrict: [
        { grant: ['CREATE','READ','UPDATE','DELETE'], to: ['PricingAnalyst', 'DealerSalesUser', 'RegionalManager', 'FinanceApprover', 'PricingAdministrator'] }
    ]
    entity PriceChangeHistory   as projection on d.PriceChangeHistory;

    //Functions
    function calculateNetPrice(priceCondition: UUID, discountType: String, discountValue: Decimal) returns NetPriceResult;

    function validateMargin(priceCondition: UUID, discountPercentage: Decimal) returns NetPriceResult;

    //Job Scheduler
    @requires: 'PricingAdministrator'
    action   activateAndExpirePrices() returns String;
}
